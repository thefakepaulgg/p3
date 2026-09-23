import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ROUTING_RPC_CHANNELS, type RoutingRpcResult } from "./routing/rpc.ts";
import type { TaskState } from "./routing/state.ts";
import { completeIfNoReadySteps, createRun, hasLiveAttempt, latestAttempt, newAttemptId, newRunId, readyStepIds, stepById, workflowReducer, type GitLedger, type WorkflowAttempt, type WorkflowRun } from "./workflows/scheduler.ts";
import { loadWorkflowDefinitions, resolveWorkflowInput, type LoadedWorkflow, type WorkflowDiagnostic } from "./workflows/schema.ts";

const RUN_ENTRY = "workflow-run-v1";
const ARTIFACT_ROOT = "workflow-artifacts";
const WORKFLOW_LAUNCH_TIMEOUT_MS = 65_000;
const HANDOFF_LIMIT = 12_000;
const PROMPT_LIMIT = 20_000;
const NOTIFICATION_LIMIT = 1_200;
const TERMINAL_TASKS = new Set<TaskState>(["completed", "failed", "stopped", "abandoned"]);
const WorkflowControlParams = Type.Object({
  action: Type.String({ description: "list, status, start, continue, back, retry, stop, resume, reload, or validate" }),
  workflowId: Type.Optional(Type.String({ maxLength: 96 })),
  goal: Type.Optional(Type.String({ maxLength: 20_000 })),
  step: Type.Optional(Type.String({ maxLength: 96 })),
  inputs: Type.Optional(Type.Record(Type.String({ maxLength: 96 }), Type.String({ maxLength: 20_000 }))),
  confirmation: Type.Optional(Type.Boolean()),
});

type RpcReply<T> = { success: boolean; data?: T; error?: string };
type WorkflowContext = ExtensionContext & { sessionManager: ExtensionContext["sessionManager"] };
type StructuredCommand = { workflowId?: string; goal?: string; step?: string; inputs?: Record<string, unknown> };

const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const bounded = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const isTerminal = (state: string) => TERMINAL_TASKS.has(state as TaskState);
const isAmbiguousTimeout = (error: unknown) => error instanceof Error && error.name === "WorkflowRpcTimeout";
const isNonRetryableWorkflowError = (error: unknown) => isAmbiguousTimeout(error) || /Dependency artifact|Dependency step|git ledger command failed/i.test(errorText(error));

class WorkflowRpcTimeout extends Error {
  constructor(channel: string, timeoutMs: number) { super(`${channel} timed out after ${timeoutMs}ms; launch outcome is ambiguous and will not be retried`); this.name = "WorkflowRpcTimeout"; }
}

/** Launch RPCs use a channel-specific budget longer than Herdr's approximately 45-second startup budget. */
function requestRpc<T>(pi: ExtensionAPI, channel: string, payload: Record<string, unknown>, timeoutMs = 8_000): Promise<T> {
  const budget = channel === ROUTING_RPC_CHANNELS.launch ? Math.max(WORKFLOW_LAUNCH_TIMEOUT_MS, timeoutMs) : timeoutMs;
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const replyChannel = `${channel}:reply:${requestId}`;
    let settled = false;
    const unsubscribe = pi.events.on(replyChannel, (raw) => {
      if (settled) return;
      settled = true; clearTimeout(timer); unsubscribe();
      const reply = raw as RpcReply<T>;
      if (reply.success) resolve(reply.data as T); else reject(new Error(reply.error ?? `${channel} failed`));
    });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; unsubscribe(); reject(new WorkflowRpcTimeout(channel, budget)); }
    }, budget);
    pi.events.emit(channel, { ...payload, requestId, version: 1 });
  });
}

function diagnosticText(diagnostics: WorkflowDiagnostic[]): string {
  return diagnostics.length ? diagnostics.map((item) => `${item.sourcePath ? `${item.sourcePath}: ` : ""}${item.message}`).join("\n") : "No workflow validation errors";
}

function workflowLines(workflows: LoadedWorkflow[], diagnostics: WorkflowDiagnostic[]): string[] {
  const lines = workflows.length ? workflows.map((workflow) => `${workflow.id} — ${workflow.name} (${workflow.steps.length} steps) · ${workflow.hash.slice(0, 12)}`) : ["No configured workflows"];
  if (diagnostics.length) lines.push(`⚠ ${diagnostics.length} configuration diagnostic${diagnostics.length === 1 ? "" : "s"}`);
  return lines;
}

function approvalText(run: WorkflowRun): string {
  const stepId = run.approvalStepId;
  const message = stepId ? run.definition.steps.find((step) => step.id === stepId)?.approvalMessage : undefined;
  return message ?? `Approval required after ${stepId ?? "the completed step"}; use /workflow continue`;
}

function statusLines(run: WorkflowRun | undefined): string[] {
  if (!run) return ["No active workflow run"];
  const lines = [`${run.workflowId} · ${run.status} · ${run.runId}`];
  for (const step of run.definition.steps) {
    const state = run.steps[step.id]; const attempt = latestAttempt(run, step.id);
    const marker = state.status === "completed" ? "✓" : state.status === "running" ? "●" : state.status === "blocked" ? "◆" : state.status === "failed" ? "✗" : state.status === "stale" ? "↻" : "○";
    lines.push(`${marker} ${step.name} [${state.status}]${attempt ? ` · ${state.attempts.length} attempt${state.attempts.length === 1 ? "" : "s"}` : ""}`);
  }
  if (run.approvalStepId) lines.push(approvalText(run));
  if (run.error) lines.push(`Error: ${run.error}`);
  if (run.status === "fork-mismatch") lines.push("Controller session mismatch; use /workflow adopt or start fresh");
  return lines;
}

class WorkflowOverlay implements Component {
  constructor(private readonly lines: () => string[], private readonly theme: Theme, private readonly done: (result?: unknown) => void) {}
  handleInput(data: string): void { if (matchesKey(data, "escape") || data === "q" || data === "\u0003") this.done(); }
  render(width: number): string[] {
    const text = this.lines();
    return [this.theme.fg("accent", this.theme.bold("Configured workflows")), ...text.slice(0, 28).map((line) => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line), "", this.theme.fg("dim", "Escape to close · mutations remain slash commands")];
  }
  invalidate(): void {}
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

async function gitLedger(pi: ExtensionAPI, cwd: string): Promise<GitLedger> {
  const exec = async (args: string[]) => {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 5_000 });
    if (result.code !== 0) throw new Error(`git ledger command failed (${args.join(" ")}): ${result.stderr?.trim() || `exit ${result.code}`}`);
    return result.stdout.trim();
  };
  const [head, porcelain, paths, stagedPaths] = await Promise.all([exec(["rev-parse", "HEAD"]), exec(["status", "--porcelain=v1"]), exec(["diff", "--name-only"]), exec(["diff", "--cached", "--name-only"])]);
  const statusPaths = porcelain.split("\n").filter(Boolean).map((line) => line.slice(3).trim());
  return { head, porcelain: porcelain || undefined, changedPaths: [...new Set([...statusPaths, ...paths.split("\n"), ...stagedPaths.split("\n")].filter(Boolean))], capturedAt: Date.now() };
}

function replaceContext(prompt: string, inputs: Record<string, string>, output: (stepId: string) => string): string {
  return prompt.replace(/(?:\{\{|\$\{)\s*((?:inputs\.[A-Za-z][A-Za-z0-9_-]*)|(?:steps\.[A-Za-z][A-Za-z0-9_-]*\.output))\s*\}\}?/g, (_match, ref: string) => {
    if (ref.startsWith("inputs.")) return inputs[ref.slice("inputs.".length)] ?? "";
    return bounded(output(ref.slice("steps.".length, -".output".length)), HANDOFF_LIMIT);
  });
}

export default function workflowEngine(pi: ExtensionAPI) {
  let loaded: LoadedWorkflow[] = [];
  let diagnostics: WorkflowDiagnostic[] = [];
  const runs = new Map<string, WorkflowRun>();
  let activeRunId: string | undefined;
  let activeCtx: WorkflowContext | undefined;
  let navigatingTree = false;
  let subscriptions: Array<() => void> = [];
  const terminalPromises = new Map<string, Promise<void>>();
  const pendingTerminal = new Map<string, Record<string, unknown>>();
  const launchPromises = new Map<string, Promise<void>>();

  const currentRun = () => activeRunId ? runs.get(activeRunId) : undefined;
  const refreshWidget = (ctx = activeCtx) => {
    if (!ctx) return;
    const run = currentRun();
    if (!run) { ctx.ui.setWidget("workflow-tracker", undefined); return; }
    const lines = [`Workflow · ${run.workflowId} · ${run.status}`];
    for (const step of run.definition.steps) {
      const state = run.steps[step.id];
      const marker = state.status === "completed" ? "✓" : state.status === "running" ? "●" : state.status === "blocked" ? "◆" : state.status === "failed" ? "✗" : state.status === "stale" ? "↻" : "○";
      lines.push(`${marker} ${step.name} · ${state.status}`);
    }
    ctx.ui.setWidget("workflow-tracker", lines);
  };
  const notifyRun = (ctx: WorkflowContext, run: WorkflowRun, message: string, level: "info" | "warning" | "error") => ctx.ui.notify(bounded(message, NOTIFICATION_LIMIT), level);
  const persist = (run: WorkflowRun) => pi.appendEntry(RUN_ENTRY, clone(run));
  const setRun = (run: WorkflowRun, persistRun = true) => {
    const previous = currentRun();
    runs.set(run.runId, run); activeRunId = run.runId;
    if (persistRun) persist(run);
    refreshWidget();
    if (!activeCtx || previous?.runId !== run.runId || previous.status === run.status) return;
    if (run.status === "paused") notifyRun(activeCtx, run, `Workflow ${run.workflowId} paused after ${run.approvalStepId ?? "the completed step"}. ${approvalText(run)}`, "info");
    else if (run.status === "failed") notifyRun(activeCtx, run, `Workflow ${run.workflowId} failed: ${run.error ?? "unknown error"}`, "error");
    else if (run.status === "stopped") notifyRun(activeCtx, run, `Workflow ${run.workflowId} stopped. Side effects were not rolled back.`, "warning");
    else if (run.status === "completed") notifyRun(activeCtx, run, `Workflow ${run.workflowId} completed successfully.`, "info");
  };
  const retryIfAllowed = (run: WorkflowRun, stepId: string): WorkflowRun => run.steps[stepId].attempts.length <= run.definition.defaults.retry ? workflowReducer(run, { type: "retry", stepId }) : run;

  const reload = (ctx: WorkflowContext) => {
    const result = loadWorkflowDefinitions({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
    loaded = result.workflows; diagnostics = result.diagnostics;
    return result;
  };

  const restore = (ctx: WorkflowContext) => {
    runs.clear(); activeRunId = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== RUN_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const run = entry.data as WorkflowRun;
      if (run.version !== "workflow-run-v1" || typeof run.runId !== "string") continue;
      runs.set(run.runId, clone(run)); activeRunId = run.runId;
    }
    const run = currentRun();
    if (run && run.controllerSessionId !== ctx.sessionManager.getSessionId()) run.status = "fork-mismatch";
    refreshWidget(ctx);
  };

  const artifactPaths = (ctx: WorkflowContext, run: WorkflowRun, stepId: string, attemptId: string) => {
    const dir = join(ctx.sessionManager.getSessionDir(), ARTIFACT_ROOT, run.runId, stepId, attemptId);
    return { dir, output: join(dir, "output.md"), metadata: join(dir, "metadata.json"), hash: join(dir, "output.sha256") };
  };
  const verifyArtifact = (attempt: WorkflowAttempt, run: WorkflowRun): string => {
    if (!attempt.outputPath || !attempt.outputHash) throw new Error(`Dependency artifact for ${run.workflowId} is unavailable (missing output reference)`);
    if (!existsSync(attempt.outputPath)) throw new Error(`Dependency artifact is unavailable: ${attempt.outputPath}`);
    let text: string;
    try { text = readFileSync(attempt.outputPath, "utf8"); } catch (error) { throw new Error(`Dependency artifact is unreadable: ${attempt.outputPath} (${errorText(error)})`); }
    const actual = createHash("sha256").update(text).digest("hex");
    if (actual !== attempt.outputHash) throw new Error(`Dependency artifact SHA mismatch: ${attempt.outputPath}`);
    const hashPath = join(dirname(attempt.outputPath), "output.sha256");
    let recordedHash: string;
    try { recordedHash = readFileSync(hashPath, "utf8").trim(); } catch { throw new Error(`Dependency artifact checksum is unavailable: ${hashPath}`); }
    if (recordedHash !== actual) throw new Error(`Dependency artifact checksum mismatch: ${hashPath}`);
    const metadataPath = join(dirname(attempt.outputPath), "metadata.json");
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { hash?: string; runId?: string; stepId?: string; attemptId?: string };
      if (metadata.hash !== actual || metadata.attemptId !== attempt.attemptId) throw new Error("metadata does not match the artifact reference");
    } catch (error) { throw new Error(`Dependency artifact metadata is unavailable or invalid: ${metadataPath} (${errorText(error)})`); }
    return text;
  };
  const artifactOutput = (run: WorkflowRun, stepId: string): string => {
    const attempt = latestAttempt(run, stepId);
    if (!attempt || attempt.status !== "completed") throw new Error(`Dependency step ${stepId} has no completed artifact`);
    return verifyArtifact(attempt, run);
  };
  const isCurrentAttempt = (ctx: WorkflowContext, owner: { runId: string; stepId: string; attemptId: string }, handle?: string, requireRunning = true) => {
    const run = runs.get(owner.runId);
    if (!run || run.controllerSessionId !== ctx.sessionManager.getSessionId() || navigatingTree) return undefined;
    if (requireRunning && run.status !== "running") return undefined;
    const attempt = run.steps[owner.stepId]?.attempts.find((candidate) => candidate.attemptId === owner.attemptId);
    if (!attempt || (requireRunning && attempt.status !== "running") || (handle && attempt.handle !== handle)) return undefined;
    return { run, attempt };
  };

  const launchReady = async (ctx: WorkflowContext, run = currentRun()): Promise<void> => {
    if (!run || run.status !== "running" || run.controllerSessionId !== ctx.sessionManager.getSessionId() || navigatingTree || hasLiveAttempt(run)) return;
    const stepId = readyStepIds(run)[0];
    if (!stepId) {
      const completed = completeIfNoReadySteps(run);
      if (completed.status !== run.status) setRun(completed);
      return;
    }
    const step = stepById(run, stepId);
    const attemptId = newAttemptId();
    const attempt: WorkflowAttempt = { attemptId, status: "running", startedAt: Date.now() };
    const next = workflowReducer(run, { type: "step-launched", stepId, attempt });
    setRun(next);
    const owner = { kind: "workflow", runId: run.runId, stepId, attemptId } as const;
    const key = `${owner.runId}:${owner.stepId}:${owner.attemptId}`;
    const launchWork = (async () => {
      try {
        let before: GitLedger | undefined;
        if (step.trackGit) before = await gitLedger(pi, ctx.cwd);
        if (!isCurrentAttempt(ctx, owner)) return;
        const promptBody = replaceContext(step.prompt, next.inputs, (dependency) => artifactOutput(next, dependency));
        const handoff = `Workflow handoff: runId=${owner.runId}, stepId=${owner.stepId}, attemptId=${owner.attemptId}. Treat this as one bounded step; return evidence and blockers only.`;
        const prompt = bounded(`${promptBody}\n\n${handoff}`, PROMPT_LIMIT);
        const dependsOn = step.needs.map((need) => latestAttempt(next, need)?.handle).filter((handle): handle is string => !!handle);
        const launched = await requestRpc<{ handle?: string; details?: Record<string, unknown>; task?: { handle?: string } }>(pi, ROUTING_RPC_CHANNELS.launch, {
          task: prompt, description: step.name, route: step.route, phase: step.phase, capabilities: step.capabilities ?? [],
          depends_on: dependsOn, owned_paths: step.ownershipPaths, owner,
        }, WORKFLOW_LAUNCH_TIMEOUT_MS);
        const handle = launched.handle ?? launched.task?.handle ?? (launched.details?.handle as string | undefined);
        if (!handle) throw new Error("routing RPC launch returned no task handle");
        const current = isCurrentAttempt(ctx, owner);
        if (!current) {
          await requestRpc(pi, ROUTING_RPC_CHANNELS.stop, { handle }).catch(() => undefined);
          return;
        }
        const changed = clone(current.run); const active = changed.steps[stepId].attempts.find((candidate) => candidate.attemptId === attemptId)!;
        active.handle = handle; if (before) active.gitBefore = before; setRun(changed);
        const fast = pendingTerminal.get(key);
        pendingTerminal.delete(key);
        if (fast) await processTerminal(ctx, fast);
        else void reconcile(ctx, changed, owner).catch(() => undefined);
      } catch (error) {
        const current = isCurrentAttempt(ctx, owner);
        if (!current) return;
        const failed = workflowReducer(current.run, { type: "step-failed", stepId, attemptId, error: errorText(error) });
        // A launch timeout is ambiguous: the remote may have launched successfully, so never retry it.
        const final = isNonRetryableWorkflowError(error) ? failed : retryIfAllowed(failed, stepId);
        setRun(final);
        if (final.status === "running") await launchReady(ctx, final);
      }
    })();
    launchPromises.set(key, launchWork);
    try { await launchWork; } finally { if (launchPromises.get(key) === launchWork) launchPromises.delete(key); }
  };

  const processTerminalOnce = async (ctx: WorkflowContext, data: Record<string, unknown>, owner: { runId: string; stepId: string; attemptId: string }, key: string): Promise<void> => {
    const initial = isCurrentAttempt(ctx, owner, String(data.handle));
    if (!initial) return;
    const state = String(data.state);
    if (state !== "completed") {
      const current = isCurrentAttempt(ctx, owner, String(data.handle));
      if (!current) return;
      const failed = workflowReducer(current.run, { type: "step-failed", stepId: owner.stepId, attemptId: owner.attemptId, error: String(data.error ?? `routed task ${state}`) });
      const retried = retryIfAllowed(failed, owner.stepId);
      setRun(retried); if (retried.status === "running") await launchReady(ctx, retried);
      return;
    }
    try {
      const result = await requestRpc<RoutingRpcResult>(pi, ROUTING_RPC_CHANNELS.result, { handle: initial.attempt.handle });
      const current = isCurrentAttempt(ctx, owner, initial.attempt.handle);
      if (!current) return;
      const text = typeof result?.result === "string" ? result.result : "";
      const step = stepById(current.run, owner.stepId);
      const after = step.trackGit ? await gitLedger(pi, ctx.cwd) : undefined;
      const revalidated = isCurrentAttempt(ctx, owner, initial.attempt.handle);
      if (!revalidated) return;
      if (step.completionRequire.includes("output-nonempty") && !text.trim()) throw new Error("output-nonempty gate failed");
      const artifact = artifactPaths(ctx, current.run, owner.stepId, owner.attemptId);
      mkdirSync(artifact.dir, { recursive: true, mode: 0o700 });
      const hash = createHash("sha256").update(text).digest("hex");
      atomicWrite(artifact.output, text);
      atomicWrite(artifact.hash, `${hash}\n`);
      atomicWrite(artifact.metadata, JSON.stringify({ version: "workflow-artifact-v1", runId: current.run.runId, stepId: owner.stepId, attemptId: owner.attemptId, hash, chars: text.length, gitBefore: initial.attempt.gitBefore, gitAfter: after }, null, 2));
      let next = workflowReducer(revalidated.run, { type: "step-completed", stepId: owner.stepId, attemptId: owner.attemptId, outputPath: artifact.output, outputHash: hash, outputChars: text.length, gitAfter: after });
      if (step.approvalAfter) next = workflowReducer(next, { type: "approval", stepId: owner.stepId });
      setRun(next);
      if (next.status === "running") await launchReady(ctx, next);
    } catch (error) {
      const current = isCurrentAttempt(ctx, owner, initial.attempt.handle);
      if (!current) return;
      const failed = workflowReducer(current.run, { type: "step-failed", stepId: owner.stepId, attemptId: owner.attemptId, error: errorText(error) });
      const retried = isNonRetryableWorkflowError(error) ? failed : retryIfAllowed(failed, owner.stepId);
      setRun(retried); if (retried.status === "running") await launchReady(ctx, retried);
    }
  };

  const processTerminal = async (ctx: WorkflowContext, data: Record<string, unknown>): Promise<void> => {
    const owner = data.owner as { kind?: string; runId?: string; stepId?: string; attemptId?: string } | undefined;
    if (!owner || owner.kind !== "workflow" || !owner.runId || !owner.stepId || !owner.attemptId) return;
    const key = `${owner.runId}:${owner.stepId}:${owner.attemptId}`;
    const current = runs.get(owner.runId);
    const attempt = current?.steps[owner.stepId]?.attempts.find((candidate) => candidate.attemptId === owner.attemptId);
    if (!current || current.runId !== activeRunId || !attempt) return;
    if (!attempt.handle) { pendingTerminal.set(key, data); return; }
    const existing = terminalPromises.get(key);
    if (existing) return existing;
    const pending = processTerminalOnce(ctx, data, owner as { runId: string; stepId: string; attemptId: string }, key);
    terminalPromises.set(key, pending);
    try { await pending; } finally { if (terminalPromises.get(key) === pending) terminalPromises.delete(key); }
  };

  const reconcile = async (ctx: WorkflowContext, run = currentRun(), explicitOwner?: { runId: string; stepId: string; attemptId: string }): Promise<void> => {
    if (!run || run.status !== "running" || run.controllerSessionId !== ctx.sessionManager.getSessionId() || navigatingTree || !run.activeStepId || !run.activeAttemptId) return;
    const owner = explicitOwner ?? { runId: run.runId, stepId: run.activeStepId, attemptId: run.activeAttemptId };
    const initial = isCurrentAttempt(ctx, owner);
    if (!initial?.attempt.handle) return;
    const status = await requestRpc<Record<string, unknown>>(pi, ROUTING_RPC_CHANNELS.status, { handle: initial.attempt.handle }).catch((error) => ({ state: "failed", error: errorText(error), handle: initial.attempt.handle }));
    const current = isCurrentAttempt(ctx, owner, initial.attempt.handle);
    if (!current || !isTerminal(String(status.state))) return;
    await processTerminal(ctx, { ...status, handle: initial.attempt.handle, owner });
  };

  const parseCommand = (args: string) => {
    const raw = args.trim();
    const separator = raw.indexOf(" ");
    const action = separator < 0 ? raw : raw.slice(0, separator);
    const tail = separator < 0 ? "" : raw.slice(separator + 1);
    const words = tail.trim().split(/\s+/).filter(Boolean);
    return { action, tail, words };
  };
  const command = async (args: string, ctx: WorkflowContext, confirmed = false, structured?: StructuredCommand, notifyErrors = true) => {
    activeCtx = ctx;
    const parsed = parseCommand(args); const action = parsed.action;
    const reclaim = new Set(["start", "resume", "adopt"]);
    try {
      if (navigatingTree && !["list", "status", "validate", "reload", "attempts", "start", "resume", "adopt"].includes(action)) throw new Error("Session-tree view is read-only; use /workflow resume, adopt, or start to reclaim execution");
      if (reclaim.has(action)) navigatingTree = false;
      if (action === "list") { ctx.ui.notify(workflowLines(loaded, diagnostics).join("\n"), "info"); return; }
      if (action === "validate") {
        const id = structured?.workflowId ?? parsed.words[0]; const selected = id ? loaded.filter((item) => item.id === id) : loaded;
        const messages = id && !selected.length ? [`Unknown workflow ${id}`] : selected.length ? selected.map((item) => `${item.id}: valid (${item.hash})`) : diagnostics.length ? [] : ["No configured workflows"];
        ctx.ui.notify([...messages, ...diagnostics.map((item) => `${item.sourcePath ?? "workflow"}: ${item.message}`)].join("\n"), diagnostics.length || (id && !selected.length) ? "error" : "info"); return;
      }
      if (action === "reload") { const result = reload(ctx); ctx.ui.notify([...workflowLines(result.workflows, result.diagnostics), ...result.diagnostics.map((item) => item.message)].join("\n"), result.diagnostics.length ? "warning" : "info"); return; }
      if (!action) {
        if (ctx.mode === "tui") await ctx.ui.custom((_tui, theme, _keys, done) => new WorkflowOverlay(() => [...workflowLines(loaded, diagnostics), "", ...statusLines(currentRun())], theme, done), { overlay: true });
        else ctx.ui.notify([...workflowLines(loaded, diagnostics), ...statusLines(currentRun())].join("\n"), "info");
        return;
      }
      if (action === "status") { ctx.ui.notify(statusLines(currentRun()).join("\n"), "info"); return; }
      if (action === "start") {
        const existing = currentRun();
        if (existing && (existing.status === "running" || existing.status === "paused" || hasLiveAttempt(existing))) {
          throw new Error(`Workflow ${existing.workflowId} is still active; stop or complete it before starting another workflow`);
        }
        const workflowId = structured?.workflowId ?? parsed.words[0];
        const workflow = loaded.find((item) => item.id === workflowId); if (!workflow) throw new Error(`Unknown workflow ${workflowId ?? ""}`);
        const goal = structured && Object.prototype.hasOwnProperty.call(structured, "goal") ? structured.goal : (parsed.words.length ? parsed.tail.slice(parsed.tail.indexOf(parsed.words[0]) + parsed.words[0].length).replace(/^\s/, "") : "");
        if (goal !== undefined && !goal.trim() && !(structured?.inputs && typeof structured.inputs.goal === "string" && structured.inputs.goal.trim())) throw new Error("Usage: /workflow start <id> <goal>");
        const inputValues: Record<string, unknown> = { ...(structured?.inputs ?? {}) };
        if (goal !== undefined) inputValues.goal = goal;
        const inputs = resolveWorkflowInput(workflow, inputValues);
        const run = createRun(workflow, inputs, ctx.sessionManager.getSessionId()); setRun(run); await launchReady(ctx, run); ctx.ui.notify(`Started ${workflow.id} (${run.runId})`, "info"); return;
      }
      const run = currentRun(); if (!run) throw new Error("No active workflow run");
      if (action === "attempts") {
        const stepId = structured?.step ?? parsed.words[0]; const rows = (stepId ? [stepById(run, stepId)] : run.definition.steps).map((step) => `${step.id}: ${run.steps[step.id].attempts.map((attempt) => `${attempt.attemptId}=${attempt.status}`).join(", ") || "none"}`); ctx.ui.notify(rows.join("\n"), "info"); return;
      }
      if (action === "adopt") {
        if (hasLiveAttempt(run)) throw new Error("Cannot adopt a workflow with a live attempt; stop it in the original controller first");
        for (const step of run.definition.steps) if (run.steps[step.id].status === "completed") verifyArtifact(latestAttempt(run, step.id)!, run);
        const adopted = clone(run); adopted.runId = newRunId(); adopted.controllerSessionId = ctx.sessionManager.getSessionId(); adopted.status = "running"; adopted.error = undefined; adopted.activeStepId = undefined; adopted.activeAttemptId = undefined; setRun(adopted); await launchReady(ctx, adopted); ctx.ui.notify(`Adopted ${run.workflowId} as ${adopted.runId}; completed artifacts remain read-only references`, "info"); return;
      }
      if (action === "continue") { if (run.status !== "paused") throw new Error("Workflow is not waiting for approval"); const next = workflowReducer(run, { type: "continue" }); setRun(next); await launchReady(ctx, next); return; }
      if (action === "resume") {
        if (run.status === "fork-mismatch") throw new Error("Workflow controller session mismatch; use /workflow adopt or start fresh");
        await reconcile(ctx, run); const refreshed = currentRun();
        if (refreshed?.status === "fork-mismatch") throw new Error("Workflow controller session mismatch; use /workflow adopt or start fresh");
        if (refreshed && refreshed.status !== "running") { const next = clone(refreshed); next.status = "running"; next.error = undefined; if (next.activeStepId) { next.steps[next.activeStepId].status = "pending"; next.activeStepId = undefined; next.activeAttemptId = undefined; } setRun(next); await launchReady(ctx, next); } else await launchReady(ctx, refreshed); return;
      }
      if (action === "retry") { if (run.activeStepId && hasLiveAttempt(run)) throw new Error("Cannot retry while a routed task is live"); const step = run.definition.steps.find((candidate) => run.steps[candidate.id].status === "failed") ?? run.definition.steps.find((candidate) => run.steps[candidate.id].status === "stale"); if (!step) throw new Error("No failed or stale step to retry"); const next = workflowReducer(run, { type: "retry", stepId: step.id }); setRun(next); await launchReady(ctx, next); return; }
      if (action === "back") {
        const step = stepById(run, structured?.step ?? parsed.words[0]); if (hasLiveAttempt(run)) throw new Error("Stop the live routed task before going back");
        if (!confirmed && ctx.hasUI && !(await ctx.ui.confirm("Re-run workflow step?", `Back to ${step.name}. Descendants will be stale; side effects are not rolled back.`))) return;
        const refreshed = currentRun(); if (!refreshed || refreshed.runId !== run.runId || hasLiveAttempt(refreshed)) throw new Error("Workflow changed while confirming back; inspect status and retry deliberately");
        const next = workflowReducer(refreshed, { type: "back", stepId: step.id }); setRun(next); await launchReady(ctx, next); return;
      }
      if (action === "stop") {
        if (!confirmed && ctx.hasUI && !(await ctx.ui.confirm("Stop workflow?", "The live routed task will be stopped; side effects are not rolled back."))) return;
        const beforeStop = currentRun(); if (!beforeStop || beforeStop.runId !== run.runId) throw new Error("Workflow changed while confirming stop");
        if (hasLiveAttempt(beforeStop)) { const attempt = latestAttempt(beforeStop, beforeStop.activeStepId!); if (attempt?.handle) await requestRpc(pi, ROUTING_RPC_CHANNELS.stop, { handle: attempt.handle }); }
        const refreshed = currentRun(); if (!refreshed || refreshed.runId !== run.runId) return;
        const next = clone(refreshed); if (next.activeStepId && next.activeAttemptId) { const attempt = next.steps[next.activeStepId].attempts.find((candidate) => candidate.attemptId === next.activeAttemptId); if (attempt) { attempt.status = "stopped"; attempt.endedAt = Date.now(); } next.steps[next.activeStepId].status = "stopped"; } next.status = "stopped"; next.activeStepId = undefined; next.activeAttemptId = undefined; setRun(next); return;
      }
      throw new Error("Usage: /workflow [list|validate [id]|start <id> <goal>|status|continue|back <step>|retry|stop|resume|attempts [step]|reload|adopt]");
    } catch (error) { if (notifyErrors) ctx.ui.notify(errorText(error), "error"); else throw error; }
  };

  const toolActions = ["list", "status", "start", "continue", "back", "retry", "stop", "resume", "reload", "validate"] as const;
  pi.registerTool({
    name: "workflow_control", label: "Workflow Control", description: "Inspect and control configuration-driven workflows.", promptSnippet: "Control a configured workflow run", parameters: WorkflowControlParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action as string;
      if (!toolActions.includes(action as typeof toolActions[number])) throw new Error(`Unknown workflow action ${action}`);
      if ((action === "back" || action === "stop") && params.confirmation !== true) throw new Error(`${action} requires confirmation=true in the tool path`);
      const before = currentRun()?.runId;
      await command(action, ctx as WorkflowContext, params.confirmation === true, { workflowId: params.workflowId, goal: params.goal, step: params.step, inputs: params.inputs }, false);
      const text = action === "list" ? workflowLines(loaded, diagnostics).join("\n") : statusLines(currentRun()).join("\n");
      return { content: [{ type: "text", text }], details: { action, runId: currentRun()?.runId ?? before, diagnostics } };
    },
  });

  pi.registerCommand("workflow", {
    description: "Inspect and control configuration-driven workflows",
    getArgumentCompletions: (prefix) => {
      const actions = [
        ["list", "List available workflow definitions"],
        ["validate", "Validate a workflow definition"],
        ["start", "Start a workflow"],
        ["status", "Show the active workflow"],
        ["continue", "Pass the current approval gate"],
        ["retry", "Retry the failed or stopped step"],
        ["back", "Create a new attempt from an earlier step"],
        ["stop", "Stop the active workflow"],
        ["resume", "Resume a restored workflow"],
        ["adopt", "Adopt a workflow restored from another session branch"],
      ] as const;
      const separator = prefix.indexOf(" ");
      if (separator < 0) {
        const query = prefix.toLowerCase();
        const matches = actions.filter(([action]) => action.startsWith(query));
        return matches.length ? matches.map(([value, description]) => ({ value, label: value, description })) : null;
      }
      const action = prefix.slice(0, separator).toLowerCase();
      const query = prefix.slice(separator + 1).trimStart().toLowerCase();
      if (action === "validate" || action === "start") {
        const matches = loaded.filter((workflow) => workflow.id.toLowerCase().startsWith(query));
        return matches.length ? matches.map((workflow) => ({ value: `${action} ${workflow.id}`, label: workflow.id, description: workflow.description })) : null;
      }
      if (action === "back") {
        const run = currentRun();
        if (!run) return null;
        const matches = run.definition.steps.filter((step) => step.id.toLowerCase().startsWith(query));
        return matches.length ? matches.map((step) => ({ value: `back ${step.id}`, label: step.id, description: step.name })) : null;
      }
      return null;
    },
    handler: command as any,
  });
  const bindSubscriptions = () => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    for (const state of ["completed", "failed", "stopped"] as const) subscriptions.push(pi.events.on(`routing:task:${state}`, (raw) => { if (activeCtx) void processTerminal(activeCtx, raw as Record<string, unknown>); }));
    const updateWorkerState = (raw: unknown, status: "running" | "blocked") => {
      const data = raw as Record<string, unknown>;
      const owner = data.owner as { kind?: string; runId?: string; stepId?: string; attemptId?: string } | undefined;
      if (!activeCtx || !owner || owner.kind !== "workflow" || !owner.runId || owner.runId !== activeRunId || !owner.stepId || !owner.attemptId) return;
      const current = runs.get(owner.runId);
      const attempt = current?.steps[owner.stepId]?.attempts.find((candidate) => candidate.attemptId === owner.attemptId);
      if (!current || !attempt || attempt.status !== "running" || (attempt.handle && attempt.handle !== data.handle)) return;
      const next = clone(current);
      next.steps[owner.stepId].status = status;
      setRun(next);
      if (status === "blocked") notifyRun(activeCtx, next, `Workflow step ${stepById(next, owner.stepId).name} is blocked and needs input. Use /subagents to inspect or steer its worker.`, "warning");
    };
    subscriptions.push(pi.events.on("routing:task:running", (raw) => updateWorkerState(raw, "running")));
    subscriptions.push(pi.events.on("routing:task:blocked", (raw) => updateWorkerState(raw, "blocked")));
  };
  pi.on("session_start", async (_event, ctx) => { activeCtx = ctx as WorkflowContext; navigatingTree = false; bindSubscriptions(); reload(activeCtx); restore(activeCtx); const run = currentRun(); if (run?.status === "running" && run.controllerSessionId === ctx.sessionManager.getSessionId()) { await reconcile(activeCtx, run); await launchReady(activeCtx, currentRun()); } });
  pi.on("session_tree", async (_event, ctx) => { activeCtx = ctx as WorkflowContext; navigatingTree = true; restore(activeCtx); });
  pi.on("session_shutdown", async () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); if (activeCtx) activeCtx.ui.setWidget("workflow-tracker", undefined); activeCtx = undefined; });
  bindSubscriptions();
}

export { diagnosticText, requestRpc };
