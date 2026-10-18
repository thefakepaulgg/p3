import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition,
  type AgentToolResult,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { redactSensitiveText } from "./advisor/context.ts";

/** Foreground window before a still-running command is handed off. Independent of `timeout`, which still kills. */
const YIELD_MS = 10_000;
const STOP_WAIT_MS = 5_000;
const COMPLETION_TYPE = "bash-job-complete";
const PREVIEW_LINES = 5;
const WIDGET_KEY = "p3-bash-jobs";

type BashResult = AgentToolResult<BashToolDetails | undefined>;
type Outcome = { result: BashResult } | { error: unknown };

interface Job {
  id: string;
  command: string;
  startedAt: number;
  endedAt?: number;
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

const elapsedSeconds = (job: Job) => Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;

const uiText = (text: string) => redactSensitiveText(stripVTControlCharacters(text)
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));

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
  let uiCtx: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshView: (() => void) | undefined;
  let closeView: (() => void) | undefined;

  const isLive = (job: Job) => !disposed && jobs.get(job.id) === job;
  const statusOf = (job: Job) => job.state === "completed" ? `completed, exit code ${job.exitCode}` : job.state;
  const jobText = (job: Job) =>
    `Job ${job.id}: ${statusOf(job)} (${elapsedSeconds(job)}s)\nCommand: ${commandLabel(job.command)}\n\n${job.finalText || textOf(job.latest) || "(no output yet)"}`;

  const refreshUi = () => {
    if (disposed || !uiCtx) return;
    const running = [...jobs.values()].filter((job) => job.state === "running");
    if (!running.length && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    } else if (running.length && !refreshTimer) {
      refreshTimer = setInterval(refreshUi, 1000);
      refreshTimer.unref();
    }
    try {
      const theme = uiCtx.ui.theme;
      const lines = running.length ? [
        `${theme.fg("dim", "╭─")} ${theme.fg("accent", theme.bold(`Bash jobs · ${running.length} running`))}${theme.fg("muted", " · /bash-jobs")}`,
        ...running.slice(0, 4).map((job) => `${theme.fg("dim", "│")} ${theme.fg("accent", "●")} ${theme.fg("text", truncateToWidth(uiText(commandLabel(job.command)).replace(/\s+/g, " "), 52))}${theme.fg("muted", ` · ${elapsedSeconds(job)}s`)}`),
        ...(running.length > 4 ? [theme.fg("dim", `│ … ${running.length - 4} more`)] : []),
        theme.fg("dim", "╰─"),
      ] : undefined;
      uiCtx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
      refreshView?.();
    } catch { /* the UI may already be gone */ }
  };

  const stopJob = async (job: Job) => {
    if (job.state !== "running") return;
    job.state = "stopped";
    job.controller.abort();
    refreshUi();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); })]);
    } finally {
      clearTimeout(timer);
    }
  };

  pi.registerCommand("bash-jobs", {
    description: "View this session's background bash jobs and output, or stop a running job",
    handler: async (_args, ctx) => {
      if (disposed || !ctx.hasUI || ctx.mode !== "tui") return;
      try {
        const choices = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((job) => ({
          job,
          label: `${job.id} · ${uiText(commandLabel(job.command)).replace(/\s+/g, " ")} · ${statusOf(job)} · ${elapsedSeconds(job)}s`,
        }));
        if (!choices.length) { ctx.ui.notify("No background bash jobs in this session", "info"); return; }
        const selected = await ctx.ui.select("Bash jobs", choices.map((choice) => choice.label));
        const job = choices.find((choice) => choice.label === selected)?.job;
        if (!job || !isLive(job)) return;
        let action: "stop" | undefined;
        do {
          action = await ctx.ui.custom<"stop" | undefined>((tui, theme, _keys, done) => {
            if (!isLive(job)) { done(undefined); return new Text(""); }
            let offset = 0;
            let maxOffset = 0;
            const pageSize = () => Math.max(1, Math.min(24, tui.terminal.rows - 8));
            refreshView = () => tui.requestRender();
            closeView = () => done(undefined);
            return {
              render(width: number) {
                if (!isLive(job)) return [];
                const lines = new Text(uiText(jobText(job)), 0, 0).render(width);
                maxOffset = Math.max(0, lines.length - pageSize());
                offset = Math.min(offset, maxOffset);
                return [
                  theme.fg("accent", theme.bold("Bash job output")),
                  // Keep status visible while scrolling through the output.
                  truncateToWidth(theme.fg("muted", `${job.id} · ${statusOf(job)} · ${elapsedSeconds(job)}s`), width),
                  ...lines.slice(offset, offset + pageSize()),
                  theme.fg("dim", `↑/↓ scroll · PgUp/PgDn page${job.state === "running" ? " · s stop job" : ""} · Esc close`),
                ].map((line) => truncateToWidth(line, width));
              },
              handleInput(data: string) {
                if (!isLive(job)) { done(undefined); return; }
                if (matchesKey(data, "escape")) done(undefined);
                else if (data === "s" && job.state === "running") done("stop");
                else {
                  if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
                  else if (matchesKey(data, "down")) offset = Math.min(maxOffset, offset + 1);
                  else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - pageSize());
                  else if (matchesKey(data, "pageDown")) offset = Math.min(maxOffset, offset + pageSize());
                  tui.requestRender();
                }
              },
              invalidate() {},
            };
          });
          refreshView = undefined;
          closeView = undefined;
          if (!isLive(job)) return;
          if (action === "stop") await stopJob(job);
        } while (action === "stop" && isLive(job));
      } catch (error) {
        if (!disposed) ctx.ui.notify(uiText(error instanceof Error ? error.message : String(error)), "error");
      } finally {
        refreshView = undefined;
        closeView = undefined;
      }
    },
  });

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
      description: `${base.description} If the command is still running after ${YIELD_MS / 1000} seconds it continues in the background: the result then has status "running" and a job_id instead of exit_code. Completion automatically wakes you with the exit code and output. Do not wait by looping, polling, or issuing short sleeps (including sleep 8 or sleep 9) to stay below the background threshold. Do independent work, or end your turn silently: no waiting announcement or acknowledgment is needed. The timeout still kills the command, in the background too.`, 
      promptGuidelines: [
        ...(base.promptGuidelines ?? []),
        `bash commands running longer than ${YIELD_MS / 1000}s continue in the background. Their completion message automatically wakes you, even after you end your turn. Never keep a turn alive with sleep 8, sleep 9, other short sleeps, repeated status/output checks, or polling loops to evade backgrounding. Do independent useful work; if nothing remains that does not depend on the result, end your turn silently. Do not announce that you are waiting, acknowledge the handoff, or claim the task is complete. Put dependent shell steps in the same command (a && b). Use bash_job output only when its current output enables useful work now or the user asks, not to wait for completion; use stop to cancel.`, 
      ],
      outputSchema: Type.Union([base.outputSchema as TSchema, runningSchema]),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // The command runs under our own controller so it can outlive the tool call after handoff.
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", forwardAbort, { once: true });

        const startedAt = Date.now();
        let handedOff = false;
        let job: Job | undefined;
        let latest: BashResult | undefined;
        const settled: Promise<Outcome> = base.execute(toolCallId, params, controller.signal, (update) => {
          latest = update;
          if (job) job.latest = update;
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
        job = {
          id: randomUUID().slice(0, 8),
          command: params.command,
          startedAt,
          controller,
          latest,
          state: "running",
          done: Promise.resolve(),
        };
        jobs.set(job.id, job);
        const backgroundJob = job;
        job.done = settled.then((outcome) => {
          const job = backgroundJob;
          job.endedAt = Date.now();
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
          refreshUi();
          if (!stopped && !disposed) notifyCompletion(job);
        });
        refreshUi();

        const soFar = textOf(latest);
        const details = latest?.details;
        return {
          content: [{
            type: "text",
            text: `${soFar ? `${soFar}\n\n` : ""}Still running after ${YIELD_MS / 1000}s; continuing in the background as job ${job.id}. Completion automatically wakes you with the result. Do not poll, loop, or issue short sleeps (including sleep 8 or sleep 9) to wait or avoid backgrounding. Do independent work, or end your turn silently without a waiting announcement or acknowledgment.`, 
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
      description: "Read the status and output of a background bash job when it enables useful work now or the user requests it, or stop it (kills its process tree). Completion automatically wakes you; never repeatedly check output/status or sleep-loop waiting for it. If no independent work remains, end your turn silently without a waiting announcement or acknowledgment.",
      parameters: Type.Object({
        job_id: Type.String({ description: "Job ID from a running bash result" }),
        action: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("stop")], { description: "Default: output" })),
      }),
      async execute(_toolCallId, { job_id, action }) {
        const job = jobs.get(job_id);
        if (!job) throw new Error(`No background bash job ${job_id} in this session.`);
        if (action === "stop") await stopJob(job);
        return {
          content: [{ type: "text", text: jobText(job) }],
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
    const [header = "", ...rest] = uiText(text).split("\n");
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
    if (ctx.hasUI) uiCtx = ctx;
    install(ctx.cwd);
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshView = undefined;
    try { closeView?.(); } catch { /* the UI may already be gone */ }
    closeView = undefined;
    try { uiCtx?.ui.setWidget(WIDGET_KEY, undefined); } catch { /* the UI may already be gone */ }
    uiCtx = undefined;
    for (const job of jobs.values()) {
      if (job.state !== "running") continue;
      job.state = "stopped";
      job.controller.abort();
    }
    jobs.clear();
  });
}
