import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAssignmentReceipt, readAssignmentResult, resultPathForAssignment, resultRefForAssignment } from "./artifacts.ts";
import { readPendingAssignmentAsk, type AssignmentAsk } from "./questions.ts";
import { orchestrationError } from "./errors.ts";
import { saveRoutedInstruction } from "./editor-guard.ts";
import { workerPolicyArgs } from "./worker-policy.ts";
import { mux, selfIdentity, type MuxAgent, type WorkerLaunchProgress } from "./mux.ts";
import { normalizeTuiAgent } from "./mux-tui.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Route } from "./policy.ts";
import { buildCompletionMessage, buildInterruptedMessage, COMPLETION_KIND, isActiveTask, type TaskHandle } from "./state.ts";
import { readIncrementalUsage } from "./usage.ts";

// Transport and TUI pane-allocation internals live in herdr-socket.ts / mux-tui.ts; these re-exports keep the historical entry point.
export { herdrSocketRequestForArgs, parseJson, requestHerdrSocket, resolveHerdrSocketPath, runHerdr, setHerdrTestTransportForTests } from "./herdr-socket.ts";
export { ROUTED_TAB_MAX_PANES } from "./mux-tui.ts";

export type RoutedWorkerCapability = "memory";

export interface HerdrLaunch { agent: string; paneId: string; tabId?: string; route: string; terminalId?: string; sessionId?: string; sessionPath?: string }

/**
 * Pi ends an Esc-interrupted turn with an empty assistant message: stopReason "aborted" from
 * agent core, or "error" with the AbortError text ("This operation was aborted") when the
 * provider request was cancelled mid-stream.
 */
const isAbortedAssistant = (message: any) =>
  message?.stopReason === "aborted" || (message?.stopReason === "error" && /\baborted\b/i.test(String(message?.errorMessage ?? "")));

/** Latest assistant text, and whether the latest assistant message ended the turn by interrupt. */
export function readHerdrTurn(sessionPath?: string): { result: string; aborted: boolean } {
  if (!sessionPath || !existsSync(sessionPath)) return { result: "", aborted: false };
  const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
  let aborted: boolean | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      const message = entry?.type === "message" ? entry.message : undefined;
      if (message?.role !== "assistant") continue;
      aborted ??= isAbortedAssistant(message);
      const text = Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
        : typeof message.content === "string" ? message.content : "";
      if (text.trim()) return { result: text.trim(), aborted };
    } catch { /* ignore incomplete JSONL tail */ }
  }
  return { result: "", aborted: aborted ?? false };
}

export const readHerdrResult = (sessionPath?: string): string => readHerdrTurn(sessionPath).result;

export const shouldCloseCompletedPane = (retention?: "keep" | "close") => retention !== "keep";

export const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function readHerdrSessionId(path?: string): string | undefined {
  if (!path) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.toString("utf8", 0, count).split("\n", 1)[0]);
    return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A name or pane alone does not establish control of the original executor. */
export function verifyTaskAgent(task: TaskHandle, observed: MuxAgent | undefined | Record<string, any>): void {
  // Callers holding a raw TUI `agent.get` payload remain valid.
  const agent = observed && "raw" in observed ? observed as MuxAgent : observed ? normalizeTuiAgent(observed) : undefined;
  if (!task.terminalId || agent?.paneId !== task.paneId || agent?.terminalId !== task.terminalId) throw new Error("Worker terminal identity is unverified or replaced");
  const sessionId = readHerdrSessionId(agent?.sessionPath);
  if (!sessionId || (task.sessionId && sessionId !== task.sessionId)) throw new Error("Worker Pi session identity is unverified or replaced");
  if (!task.sessionId) task.sessionId = sessionId;
}

export async function proveTaskAbsent(pi: ExtensionAPI, task: TaskHandle): Promise<boolean> {
  if (!task.paneId || !task.terminalId || !task.sessionId) throw new Error("Original executor identity is incomplete; absence is unverified");
  const agents = await mux().listAgents(pi);
  if (!agents) throw new Error("Agent inventory is incomplete; absence is unverified");
  return !agents.some((agent) => agent.paneId === task.paneId || agent.terminalId === task.terminalId || readHerdrSessionId(agent.sessionPath) === task.sessionId);
}

/** Reconcile only proven-exited executors; registry failure alone never authorizes a second writer. */
export async function recoverAbsentTask(pi: ExtensionAPI, task: TaskHandle): Promise<Partial<TaskHandle> | undefined> {
  try {
    if (!task.paneId || !task.sessionId || !task.assignmentId || task.pendingCompletion) return undefined;
    const agents = await mux().listAgents(pi);
    if (!agents || agents.some((agent) => agent.paneId === task.paneId ||
      (task.terminalId && agent.terminalId === task.terminalId) || agent.name === task.agentName ||
      readHerdrSessionId(agent.sessionPath) === task.sessionId || (agent.kind === "pi" && agent.launchPending))) return undefined;
    const receipt = readAssignmentReceipt(task.assignmentId);
    if (receipt) {
      const failed = task.state === "failed" && receipt.outcome === "error";
      if ((!failed && !["running", "aborted"].includes(receipt.outcome)) || receipt.requestId !== task.requestId || receipt.generation < (task.minimumGeneration ?? 1)) return undefined;
      if (receipt.sessionId !== task.sessionId || receipt.paneId !== task.paneId || receipt.terminalId !== task.terminalId ||
        !Number.isSafeInteger(receipt.workerPid) || receipt.workerPid! <= 0 || readHerdrSessionId(receipt.sessionPath) !== task.sessionId) return undefined;
      try { process.kill(receipt.workerPid!, 0); return undefined; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined; }
      if (failed) return { presence: "lost", sessionPath: receipt.sessionPath };
      return { state: "suspended", presence: "lost", sessionPath: receipt.sessionPath, workerPid: receipt.workerPid,
        costComplete: false, error: "Executor exited; saved conversation is available for open or explicit resume. No work was replayed." };
    }
    // Before interactive readiness there is no worker PID to verify. Only retire the
    // failed launch once its exact allocated pane is gone; never close a guessed pane.
    if (task.sessionPath || task.terminalId) return undefined;
    const panes = await mux().listPanes(pi);
    if (!panes || panes.some((pane) => pane.paneId === task.paneId)) return undefined;
    return { state: "failed", presence: "lost", endedAt: Date.now(), costComplete: false,
      error: "Startup never established a saved worker session and its allocated pane is absent; this failed launch can be cleared." };
  } catch { return undefined; }
}

export function watchHerdrTask(options: {
  pi: ExtensionAPI;
  task: TaskHandle;
  watchers: Map<string, AbortController>;
  baselineResult?: string;
  update: (patch: Partial<TaskHandle>, persist?: boolean) => void;
  persist: () => void;
  notify: (kind: string, content: string) => void;
  question?: (ask: AssignmentAsk) => void;
}): void {
  const { pi, task, watchers, update, notify } = options;
  const controller = new AbortController();
  watchers.get(task.handle)?.abort();
  watchers.set(task.handle, controller);
  void (async () => {
    let errors = 0;
    let staleEpisode: number | undefined;
    let interruptedGeneration: number | undefined;
    const watching = () => !controller.signal.aborted && isActiveTask(task);
    while (watching()) {
      try {
        const receipt = task.assignmentId ? readAssignmentReceipt(task.assignmentId) : undefined;
        const ask = task.assignmentId ? readPendingAssignmentAsk(task.assignmentId) : undefined;
        if (ask && (ask.requestId !== task.requestId || ask.parentSessionId !== task.parentSessionId || ask.sessionId !== task.sessionId || ask.paneId !== task.paneId || ask.terminalId !== task.terminalId)) throw new Error("Outstanding question identity conflicts with its owner");
        if (task.pendingAskId !== ask?.id) update({ pendingAskId: ask?.id });
        const updateUsage = (path?: string) => {
          const usage = readIncrementalUsage(path, { sessionPath: task.sessionPath, offset: task.usageOffset ?? 0, cost: task.estimatedCost ?? 0,
            costKnown: task.costKnown ?? false, complete: task.costComplete, model: task.model, thinking: task.thinking }, { startOffset: task.usageStartOffset ?? 0 });
          if (usage.changed) update({ sessionPath: usage.sessionPath, usageOffset: usage.offset, estimatedCost: usage.cost,
            costKnown: usage.costKnown, costComplete: usage.complete, ...(usage.model ? { model: usage.model } : {}), ...(usage.thinking ? { thinking: usage.thinking } : {}) }, false);
        };
        if (receipt && !task.sessionId && task.sessionPath === receipt.sessionPath && readHerdrSessionId(receipt.sessionPath) === receipt.sessionId) update({ sessionId: receipt.sessionId });
        if (receipt && receipt.requestId === task.requestId && receipt.generation >= (task.minimumGeneration ?? 1)) {
          if (receipt.paneId !== task.paneId || receipt.terminalId !== task.terminalId || receipt.sessionId !== task.sessionId) throw new Error("Assignment outcome identity conflicts with the launched executor");
          update({ lastActivityAt: receipt.lastActivityAt, outcomeGeneration: receipt.generation, workerPid: receipt.workerPid }, false);
          if (!task.background && !ask && receipt.outcome === "completed") {
            updateUsage(receipt.sessionPath);
            if (!receipt.resultHash || !receipt.responseEntryId) throw new Error("Successful assignment lacks durable response evidence");
            const result = readAssignmentResult(receipt.requestId, receipt.resultHash);
            const metadata = JSON.parse(readFileSync(join(resultPathForAssignment(receipt.requestId), "..", "metadata.json"), "utf8"));
            if (metadata.sessionId !== receipt.sessionId || metadata.generation !== receipt.generation || metadata.responseEntryId !== receipt.responseEntryId) throw new Error("Result artifact belongs to another execution generation");
            if (!watching()) return;
            update({ state: "completed", endedAt: Date.now(), resultChars: result.length, result,
              resultRef: resultRefForAssignment(receipt.requestId), resultPath: resultPathForAssignment(receipt.requestId), resultHash: receipt.resultHash });
            notify(COMPLETION_KIND, buildCompletionMessage(task, result));
            return;
          }
          if (!task.background && !ask && receipt.outcome === "error") {
            updateUsage(receipt.sessionPath);
            update({ state: "failed", endedAt: Date.now(), error: receipt.error ?? "Pi execution failed" });
            notify("failed", `Subagent ${task.handle} failed: ${receipt.error ?? "Pi execution failed"}. Partial assistant text is not a successful result. Inspect external effects before continuing.`);
            return;
          }
          if (!task.background && !ask && receipt.outcome === "aborted" && interruptedGeneration !== receipt.generation) {
            interruptedGeneration = receipt.generation;
            update({ state: "interrupted" });
            notify(`interrupted#${receipt.generation}`, buildInterruptedMessage(task, ""));
          }
        }
        const agent = await mux().getAgent(pi, task.agentName!);
        if (!watching()) return;
        verifyTaskAgent(task, agent);
        const status = agent!.status;
        updateUsage(agent!.sessionPath);
        errors = 0;
        // A worker idle only while its background bash jobs run is still executing its assignment.
        const awaitingBackground = !!receipt && receipt.requestId === task.requestId && receipt.generation >= (task.minimumGeneration ?? 1) &&
          receipt.outcome === "running" && (receipt.backgroundJobs ?? 0) > 0;
        const state = ask || status === "blocked" ? "blocked" : status === "working" || task.background || awaitingBackground ? "running" : receipt && receipt.requestId === task.requestId && receipt.outcome === "aborted" ? "interrupted" : "unknown";
        update({ state, presence: "live" }, task.state !== state || task.presence !== "live");
        if (ask) options.question?.(ask);
        else if (state === "blocked") notify(`blocked#${receipt?.generation ?? 0}`, `Subagent ${task.handle} is blocked; supply the missing decision with steer.`);
        const activity = receipt?.lastActivityAt ?? task.startedAt;
        if (state === "running" && Date.now() - activity >= 10 * 60_000 && staleEpisode !== activity) {
          staleEpisode = activity;
          const evidence = await mux().read(pi, task.agentName!, 20).catch(() => "Live diagnostic unavailable");
          if (!watching()) return;
          notify(`stale#${receipt?.generation ?? 0}`, `Subagent ${task.handle} has no execution progress for ten minutes. This is not proof of a hang. Current bounded evidence:\n${evidence.slice(-600)}\nUse existing evidence first; do not repeat diagnostic reads merely to poll.`);
        }
      } catch (error) {
        if (!watching()) return;
        const message = error instanceof Error ? error.message : String(error);
        errors++;
        const recovered = await recoverAbsentTask(pi, task);
        if (!watching()) return;
        if (recovered) {
          update(recovered);
          notify(recovered.state!, `Subagent ${task.handle}: ${recovered.error}`);
          return;
        }
        let lost = false;
        if (/agent_not_found/.test(message)) {
          try {
            lost = await proveTaskAbsent(pi, task);
          } catch { /* Unavailable inventory does not prove absence. */ }
        }
        update({ state: lost ? "lost" : "unknown", presence: lost ? "lost" : "unknown", error: message }, task.state !== (lost ? "lost" : "unknown"));
        notify(lost ? "lost" : "unknown", `Subagent ${task.handle}: ${lost ? "the original executor is proven absent" : "runtime identity cannot be verified"}. Work remains unresolved. No replacement or tool replay was started. ${message.slice(0, 200)}`);
      }
      await sleep(errors ? Math.min(10000, 1000 * 2 ** Math.min(errors, 4)) : 1000, controller.signal);
    }
  })().finally(() => { if (watchers.get(task.handle) === controller) watchers.delete(task.handle); });
}

const HERDR_AGENT_READY_TIMEOUT_MS = 30_000;

export function buildRoutedWorkerPiArgs(description: string, route: Route, _capabilities: RoutedWorkerCapability[] = [], readonly = false, assignmentId?: string, continuation?: { path: string; id: string }): string[] {
  return [
    // PR subscriptions belong to the root session.
    "--exclude-tools", "subagent,subagent_control,workspace_agent,workspace_agent_control,peer_connection,model_route,workflow_control,pr_subscribe,pr_unsubscribe",
    "--model", route.launchModel ?? `${route.provider}/${route.model}`,
    "--thinking", clampThinkingLevel(route.thinking),
    "--name", description,
    ...workerPolicyArgs(readonly),
    ...(assignmentId ? [...(continuation ? ["--session", continuation.path] : ["--session-id", assignmentId]), "--extension", fileURLToPath(new URL("./worker-lifecycle.ts", import.meta.url))] : []),
  ];
}

const isHerdrAgentReady = (agent: MuxAgent | undefined): boolean => {
  if (!agent || agent.launchPending === true) return false;
  if (agent.interactiveReady === true) return true;
  // A freshly started Pi agent passes through idle while launch_pending is still set.
  // Require explicit interactive readiness for idle; working/done/blocked are concrete
  // evidence that the agent has already accepted input.
  return ["working", "done", "blocked"].includes(agent.status);
};

export async function waitForHerdrAgentReady(pi: ExtensionAPI, agentName: string, timeout = HERDR_AGENT_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastState = "no agent state";
  let observedAgent = false;
  while (Date.now() < deadline) {
    try {
      const agent = await mux().getAgent(pi, agentName);
      observedAgent ||= !!agent;
      const status = agent?.status ?? "unknown";
      lastState = `status=${status} launch_pending=${String(agent?.launchPending)} interactive_ready=${String(agent?.interactiveReady)}`;
      if (["error", "exited", "failed", "terminated"].includes(status)) {
        throw new Error(`agent_start_failed: ${agentName} entered terminal startup status ${status}`);
      }
      if (isHerdrAgentReady(agent)) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastState = message;
      if (!/agent_(?:not_found|not_ready)/.test(message)) throw error;
      // A name may not resolve during initial registration. If it disappears after
      // Herdr has already returned concrete agent state, fail rather than waiting 30s.
      if (observedAgent && /agent_not_found/.test(message)) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`agent_start_timeout: ${agentName} did not become prompt-ready within ${timeout}ms (${lastState})`);
}

export async function launchHerdrAgent(pi: ExtensionAPI, task: string, description: string, routeName: string, route: Route, cwd: string, readyTimeout = HERDR_AGENT_READY_TIMEOUT_MS, manifestPath?: string, capabilities: RoutedWorkerCapability[] = [], background = false, options: { assignmentId?: string; readonly?: boolean; handle?: string; continuation?: { path: string; id: string }; onAllocated?: (launch: HerdrLaunch) => void; onStarted?: (launch: HerdrLaunch) => void } = {}): Promise<HerdrLaunch> {
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "task";
  const name = `r-${slug}-${Date.now().toString(36).slice(-5)}`.slice(0, 32);
  const progress: WorkerLaunchProgress = { stage: "pane_allocation", attempted: false, started: false, retryAttempted: false };
  let agent = name;
  let paneId: string | undefined;
  let tabId: string | undefined;
  try {
    const startArgs = buildRoutedWorkerPiArgs(description, route, capabilities, options.readonly, options.assignmentId, options.continuation);
    const worker = await mux().launchWorker(pi, {
      name, cwd, args: startArgs, manifestPath, background, assignmentId: options.assignmentId, readonly: options.readonly,
      handle: options.handle, sessionPath: options.continuation?.path,
      onAllocated: (allocated) => {
        ({ agent, paneId, tabId } = allocated);
        options.onAllocated?.({ agent, paneId, tabId, route: routeName, sessionId: options.continuation?.id ?? options.assignmentId, sessionPath: options.continuation?.path });
      },
    }, progress);
    ({ agent, paneId, tabId } = worker);
    // Herdr 0.8.0's socket method acknowledges agent.start as soon as the process
    // launches, often several seconds before the name is prompt-ready. The CLI waits
    // for this transition internally; the direct socket transport must do the same.
    progress.stage = "interactive_readiness";
    if (!isHerdrAgentReady(worker.started)) await waitForHerdrAgentReady(pi, agent, readyTimeout);
    progress.stage = "executor_identity";
    const info = await mux().getAgent(pi, agent);
    const sessionPath = info?.sessionPath;
    const launch: HerdrLaunch = { agent, paneId: paneId!, tabId, route: routeName, terminalId: info?.terminalId, sessionPath, sessionId: readHerdrSessionId(sessionPath) ?? options.continuation?.id ?? options.assignmentId };
    if (options.continuation && (launch.sessionId !== options.continuation.id || (!sessionPath || realpathSync(sessionPath) !== realpathSync(options.continuation.path)))) throw new Error("Continuation started with conflicting saved-session identity");
    options.onStarted?.(launch);
    const contract = background
      ? "Background contract: you are a long-lived background subagent. The parent agent never receives your output automatically and may later read your latest reply, so end each turn with a short current-status summary. Own only this assignment; do not delegate. Use notify_user (Telegram) only when the user must act or when something important finished."
      : "Task contract: own only this assignment; do not broaden scope or delegate. Report the outcome, changed artifacts or findings, evidence actually observed, and concrete blockers or risks. Use ask_parent for a missing decision that blocks this assignment; do not finish with an unanswered question.";
    const prompt = [...(options.assignmentId ? [`p3:routed-request ${options.assignmentId}`] : []), task, "", contract].join("\n");
    if (options.assignmentId) saveRoutedInstruction(options.assignmentId, options.assignmentId, prompt);
    progress.stage = "task_submission";
    // One socket request both submits and observes the first working transition. If Herdr
    // 0.8.0's delayed Enter is swallowed, submit only the existing composer text and verify
    // activity; never paste the prompt twice.
    try {
      await mux().prompt(pi, agent, prompt, { awaitStart: true });
    } catch (error) {
      if (!/agent_prompt_stalled/.test(error instanceof Error ? error.message : String(error))) throw error;
      await mux().sendKeys(pi, agent, ["enter"]);
      try {
        await mux().wait(pi, agent, ["working", "done", "blocked"], 5000);
      } catch (recoveryError) {
        // A very fast task can settle before the follow-up wait attaches. Accept concrete
        // lifecycle/result evidence; otherwise preserve the started pane for inspection.
        const info = await mux().getAgent(pi, agent).catch(() => undefined);
        const result = readHerdrResult(info?.sessionPath);
        if (!(info?.status === "working" || info?.status === "done" || info?.status === "blocked" || result)) throw recoveryError;
      }
    }
    return launch;
  } catch (error) {
    if (!progress.worker) throw orchestrationError(error, "launch", { stage: "pane_allocation", retrySafe: "unknown", nextAction: "Inspect allocation evidence before retrying; no guessed pane or tab was removed." });
    const { stage, started, attempted, retryAttempted } = progress;
    const ids = { agent, paneId, tabId, assignmentId: options.assignmentId, sessionId: options.continuation?.id ?? options.assignmentId };
    if (started || attempted || retryAttempted) throw orchestrationError(error, "launch", { category: "ambiguous_startup", stage, ids, retryAttempted, retrySafe: "unknown",
      nextAction: "Inspect the retained exact pane/session before retrying; startup or submission may have acted. No prompt was replayed or replacement started." });
    let cleanupError: unknown;
    try {
      const panes = await mux().listPanes(pi, selfIdentity().rootWorkspaceId);
      if (!panes || !panes.some((pane) => pane.paneId === paneId)) throw new Error("Original rollback pane could not be verified");
      // Another assignment may already have split this tab; roll back only this pane.
      await mux().closePane(pi, paneId!);
    } catch (failure) { cleanupError = failure; }
    throw orchestrationError(error, "launch", { stage, ids, retryAttempted, rollbackOccurred: !cleanupError, retrySafe: !cleanupError,
      primary: { message: error instanceof Error ? error.message : String(error) }, ...(cleanupError ? { cleanup: { message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) } } : {}),
      nextAction: cleanupError ? "Inspect both startup and cleanup failures before retrying; retained resources are not guessed away." : "The exact fresh pane was rolled back before launch; resolve the startup failure before retrying." });
  }
}
