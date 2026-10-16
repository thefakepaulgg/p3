import { randomUUID } from "node:crypto";
import {
  createBashToolDefinition,
  type AgentToolResult,
  type BashToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { redactSensitiveText } from "./advisor/context.ts";

/** Foreground window before a still-running command is handed off. Independent of `timeout`, which still kills. */
const YIELD_MS = 10_000;
const STOP_WAIT_MS = 5_000;
const COMPLETION_TYPE = "bash-job-complete";
const PREVIEW_LINES = 5;

type BashResult = AgentToolResult<BashToolDetails | undefined>;
type Outcome = { result: BashResult } | { error: unknown };

interface Job {
  id: string;
  command: string;
  startedAt: number;
  controller: AbortController;
  /** Latest streamed snapshot while running. */
  latest: BashResult | undefined;
  state: "running" | "completed" | "failed" | "stopped";
  /** Final model-facing text once settled. */
  finalText?: string;
  exitCode?: number;
  /** Resolves after the job's outcome has been recorded. */
  done: Promise<void>;
}

const textOf = (result: BashResult | undefined) =>
  result?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";

const elapsedSeconds = (job: Job) => Math.round((Date.now() - job.startedAt) / 100) / 10;

const commandLabel = (command: string) => {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 200 || command.trim().includes("\n") ? `${line.slice(0, 200)} …` : line;
};

/**
 * Replace the built-in `bash` with one that yields after YIELD_MS: the command keeps running in this Pi
 * process and a single completion message wakes the agent later. Only installed in the interactive TUI,
 * and only when `bash` is still the built-in, so sandbox/remote overrides are never displaced.
 */
export default function bashBackground(pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();
  let installed = false;
  let disposed = false;

  const notifyCompletion = (job: Job) => {
    const status = job.state === "completed"
      ? `exited with code ${job.exitCode}`
      : "failed";
    const content = redactSensitiveText(
      `Background bash job ${job.id} ${status} after ${elapsedSeconds(job)}s.\nCommand: ${commandLabel(job.command)}\n\n${job.finalText || "(no output)"}`,
    );
    try {
      pi.sendMessage({
        customType: COMPLETION_TYPE,
        content,
        display: true,
        details: { jobId: job.id, state: job.state, exitCode: job.exitCode },
      }, { deliverAs: "steer", triggerTurn: true });
    } catch {
      // The runtime was replaced; never deliver into another session.
    }
  };

  const install = (cwd: string) => {
    const settings = pi.getSettings();
    const base = createBashToolDefinition(cwd, {
      commandPrefix: settings.shellCommandPrefix,
      shellPath: settings.shellPath,
    });
    const runningSchema = Type.Object({
      status: Type.Literal("running"),
      job_id: Type.String({ description: "Background job ID for bash_job" }),
      output: Type.String({ description: "Output so far, possibly truncated" }),
      truncated: Type.Boolean(),
      full_output_path: Type.Optional(Type.String()),
      wall_time_seconds: Type.Number(),
    });

    pi.registerTool({
      ...base,
      description: `${base.description} If the command is still running after ${YIELD_MS / 1000} seconds it continues in the background: the result then has status "running" and a job_id instead of exit_code, and a completion message with the exit code and output arrives automatically when it ends. The timeout still kills the command, in the background too.`,
      promptGuidelines: [
        ...(base.promptGuidelines ?? []),
        `bash commands running longer than ${YIELD_MS / 1000}s continue in the background and report completion automatically; do not poll or sleep waiting for them. Put dependent steps in the same command (a && b). Use bash_job to read a job's output or stop it.`,
      ],
      outputSchema: Type.Union([base.outputSchema as TSchema, runningSchema]),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // The command runs under our own controller so it can outlive the tool call after handoff.
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", forwardAbort, { once: true });

        let handedOff = false;
        let latest: BashResult | undefined;
        const settled: Promise<Outcome> = base.execute(toolCallId, params, controller.signal, (update) => {
          latest = update;
          if (!handedOff) onUpdate?.(update);
        }, ctx).then((result) => ({ result }), (error: unknown) => ({ error }));

        let yieldNow: (value: undefined) => void = () => {};
        const timer = setTimeout(() => yieldNow(undefined), YIELD_MS);
        const first = await Promise.race([settled, new Promise<undefined>((resolve) => { yieldNow = resolve; })]);
        clearTimeout(timer);

        if (first || signal?.aborted || disposed) {
          if (disposed) controller.abort();
          const outcome = first ?? await settled;
          signal?.removeEventListener("abort", forwardAbort);
          if ("error" in outcome) throw outcome.error;
          return outcome.result;
        }

        // Handoff: the turn's abort no longer reaches the command; bash_job stop and session shutdown do.
        handedOff = true;
        signal?.removeEventListener("abort", forwardAbort);
        const job: Job = {
          id: randomUUID().slice(0, 8),
          command: params.command,
          startedAt: Date.now() - YIELD_MS,
          controller,
          latest,
          state: "running",
          done: Promise.resolve(),
        };
        jobs.set(job.id, job);
        job.done = settled.then((outcome) => {
          const stopped = job.state === "stopped";
          if ("error" in outcome) {
            job.finalText = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            if (!stopped) job.state = "failed";
          } else {
            job.finalText = textOf(outcome.result);
            const exitCode = (outcome.result.structuredContent as { exit_code?: number } | undefined)?.exit_code;
            job.exitCode = exitCode;
            if (!stopped) job.state = "completed";
          }
          job.latest = undefined;
          if (!stopped && !disposed) notifyCompletion(job);
        });

        const soFar = textOf(latest);
        const details = latest?.details;
        return {
          content: [{
            type: "text",
            text: `${soFar ? `${soFar}\n\n` : ""}Still running after ${YIELD_MS / 1000}s; continuing in the background as job ${job.id}. A completion message will arrive when it ends.`,
          }],
          details,
          structuredContent: {
            status: "running",
            job_id: job.id,
            output: soFar,
            truncated: details?.truncation?.truncated ?? false,
            ...(details?.fullOutputPath ? { full_output_path: details.fullOutputPath } : {}),
            wall_time_seconds: YIELD_MS / 1000,
          },
        };
      },
    });

    pi.registerTool({
      name: "bash_job",
      label: "bash job",
      description: "Read the status and output of a background bash job, or stop it (kills its process tree). Completion is reported automatically; do not poll.",
      parameters: Type.Object({
        job_id: Type.String({ description: "Job ID from a running bash result" }),
        action: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("stop")], { description: "Default: output" })),
      }),
      async execute(_toolCallId, { job_id, action }) {
        const job = jobs.get(job_id);
        if (!job) throw new Error(`No background bash job ${job_id} in this session.`);
        if (action === "stop" && job.state === "running") {
          job.state = "stopped";
          job.controller.abort();
          await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
        }
        const status = job.state === "completed" ? `completed, exit code ${job.exitCode}` : job.state;
        const output = job.state === "running" ? textOf(job.latest) : job.finalText;
        return {
          content: [{ type: "text", text: `Job ${job.id}: ${status} (${elapsedSeconds(job)}s)\nCommand: ${commandLabel(job.command)}\n\n${output || "(no output yet)"}` }],
          details: { jobId: job.id, state: job.state, exitCode: job.exitCode },
        };
      },
    });
  };

  // Registered unconditionally so restored transcripts render completions compactly.
  pi.registerMessageRenderer(COMPLETION_TYPE, (message, { expanded }, theme) => {
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    const [header = "", ...rest] = text.split("\n");
    const body = rest.join("\n").trim();
    const lines = body ? body.split("\n") : [];
    const shown = expanded ? lines : lines.slice(-PREVIEW_LINES);
    const hidden = lines.length - shown.length;
    return new Text([
      theme.fg("toolTitle", theme.bold(header)),
      ...(hidden > 0 ? [theme.fg("muted", `… ${hidden} earlier lines (expand to show)`)] : []),
      ...shown.map((line) => theme.fg("toolOutput", line)),
    ].join("\n"), 1, 1);
  });

  pi.on("session_start", (_event, ctx) => {
    if (installed || ctx.mode !== "tui") return;
    const current = pi.getAllTools().find((tool) => tool.name === "bash");
    if (!current) return; // bash is not allowed in this session
    if (current.sourceInfo.source !== "builtin") {
      ctx.ui.notify(`p3 bash auto-background is off: bash is provided by ${current.sourceInfo.path}.`, "warning");
      return;
    }
    installed = true;
    install(ctx.cwd);
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    for (const job of jobs.values()) {
      if (job.state !== "running") continue;
      job.state = "stopped";
      job.controller.abort();
    }
    jobs.clear();
  });
}
