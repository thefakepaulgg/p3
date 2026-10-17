import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAssignmentReceipt, readAssignmentResult, resultPathForAssignment, resultRefForAssignment } from "./artifacts.ts";
import { readPendingAssignmentAsk, type AssignmentAsk } from "./questions.ts";
import { orchestrationError } from "./errors.ts";
import { saveRoutedInstruction } from "./editor-guard.ts";
import { workerPolicyArgs } from "./worker-policy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Route } from "./policy.ts";
import { buildCompletionMessage, buildInterruptedMessage, COMPLETION_KIND, isActiveTask, type TaskHandle } from "./state.ts";
import { readIncrementalUsage } from "./usage.ts";

export type RoutedWorkerCapability = "memory";

export interface HerdrLaunch { agent: string; paneId: string; tabId: string; route: string; terminalId?: string; sessionId?: string; sessionPath?: string }

export const ROUTED_TAB_MAX_PANES = 4;
const ROUTED_TAB_LABEL = "Subagents";
let allocationTail: Promise<void> = Promise.resolve();

interface PaneAllocation { paneId: string; tabId: string; createdTab: boolean }

const withAllocationLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const previous = allocationTail;
  let release!: () => void;
  allocationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); }
};

const rootContext = () => {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new Error("Herdr routing requires this primary session to run inside a Herdr-managed pane");
  }
  const workspaceId = process.env.PI_ROUTED_ROOT_WORKSPACE_ID ?? process.env.HERDR_WORKSPACE_ID;
  const rootTabId = process.env.PI_ROUTED_ROOT_TAB_ID ?? process.env.HERDR_TAB_ID;
  if (!workspaceId || !rootTabId) throw new Error("Herdr routing requires workspace and tab context for isolated agent tabs");
  return { workspaceId, rootTabId };
};

const routedTabBaseLabel = (rootTabId: string) => `${ROUTED_TAB_LABEL} · ${rootTabId.split(":").at(-1)}`;

const routedTabIndex = (label: string, base: string): number | undefined => {
  if (label === base) return 1;
  const match = label.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · (\\d+)$`));
  const value = Number(match?.[1]);
  return Number.isInteger(value) && value > 1 ? value : undefined;
};

const splitDirection = (rect?: { width?: number; height?: number }) => {
  const width = Number(rect?.width ?? 0);
  const height = Number(rect?.height ?? 0);
  return width >= 120 && width >= height * 2 ? "right" : "down";
};

export async function allocateRoutedAgentPane(pi: ExtensionAPI, cwd: string, manifestPath?: string, background = false, assignmentId?: string, readonly = false): Promise<PaneAllocation> {
  return withAllocationLock(async () => {
    const { workspaceId, rootTabId } = rootContext();
    const manifestEnv = [
      ...(manifestPath ? ["--env", `PI_ROUTING_MANIFEST=${manifestPath}`] : []),
      ...(background ? ["--env", "PI_SUBAGENT_MODE=background"] : []),
      ...(assignmentId ? ["--env", `PI_ROUTED_ASSIGNMENT_ID=${assignmentId}`] : []),
      ...(readonly ? ["--env", "PI_ROUTED_READONLY=1"] : []),
    ];
    const base = routedTabBaseLabel(rootTabId);
    const listed = parseJson(await runHerdr(pi, ["tab", "list", "--workspace", workspaceId], 5000), "herdr tab list");
    const routedTabs = (listed?.result?.tabs ?? [])
      .map((tab: any) => ({ ...tab, routedIndex: routedTabIndex(String(tab.label ?? ""), base) }))
      .filter((tab: any) => tab.routedIndex !== undefined)
      .sort((a: any, b: any) => a.routedIndex - b.routedIndex);
    const available = routedTabs.find((tab: any) => Number(tab.pane_count ?? 0) < ROUTED_TAB_MAX_PANES);

    if (!available) {
      const used = new Set<number>(routedTabs.map((tab: any) => tab.routedIndex));
      let index = 1;
      while (used.has(index)) index += 1;
      const label = index === 1 ? base : `${base} · ${index}`;
      const created = parseJson(await runHerdr(pi, [
        "tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label,
        "--env", `PI_ROUTED_ROOT_WORKSPACE_ID=${workspaceId}`,
        "--env", `PI_ROUTED_ROOT_TAB_ID=${rootTabId}`,
        ...manifestEnv,
        "--no-focus",
      ], 10000), "herdr tab create");
      const paneId = created?.result?.root_pane?.pane_id as string | undefined;
      const tabId = created?.result?.tab?.tab_id as string | undefined;
      if (!paneId || !tabId) {
        throw orchestrationError(new Error("Herdr tab creation succeeded without returning a tab and root pane ID"), "launch", { stage: "pane_allocation", ids: { tabId }, retrySafe: "unknown", nextAction: "Inspect the allocation before retrying; missing identity never authorizes guessed container cleanup." });
      }
      return { paneId, tabId, createdTab: true };
    }

    const tabId = available.tab_id as string;
    const panes = parseJson(await runHerdr(pi, ["pane", "list", "--workspace", workspaceId], 5000), "herdr pane list")?.result?.panes ?? [];
    const tabPanes = panes.filter((pane: any) => pane.tab_id === tabId);
    if (!tabPanes.length) throw new Error(`Subagent tab ${tabId} has no panes`);
    const layout = parseJson(await runHerdr(pi, ["pane", "layout", "--pane", tabPanes[0].pane_id], 5000), "herdr pane layout");
    const layoutPanes = layout?.result?.layout?.panes ?? [];
    const target = [...layoutPanes].sort((a: any, b: any) => {
      const area = (pane: any) => Number(pane?.rect?.width ?? 0) * Number(pane?.rect?.height ?? 0);
      return area(b) - area(a);
    })[0] ?? { pane_id: tabPanes[0].pane_id };
    const split = parseJson(await runHerdr(pi, [
      "pane", "split", "--pane", target.pane_id, "--direction", splitDirection(target.rect), "--cwd", cwd,
      "--env", `PI_ROUTED_ROOT_WORKSPACE_ID=${workspaceId}`,
      "--env", `PI_ROUTED_ROOT_TAB_ID=${rootTabId}`,
      ...manifestEnv,
      "--no-focus",
    ], 10000), "herdr pane split");
    const paneId = split?.result?.pane?.pane_id as string | undefined;
    if (!paneId) throw new Error("Herdr split succeeded without returning a pane ID");
    return { paneId, tabId, createdTab: false };
  });
}

export function parseJson(text: string, command: string): any {
  try { return JSON.parse(text); }
  catch { throw new Error(`${command} returned invalid JSON: ${text.slice(0, 300)}`); }
}

interface HerdrSocketRequest {
  method: string;
  params: Record<string, unknown>;
  textResult?: (response: any) => string;
}

type HerdrTestTransport = (pi: ExtensionAPI, args: string[], timeout: number) => Promise<string>;
const MAX_SOCKET_RESPONSE_BYTES = 16 * 1024 * 1024;
let requestSequence = 0;
let testTransport: HerdrTestTransport | undefined;

/** Test seam only; production callers always use the socket transport. */
export function setHerdrTestTransportForTests(transport?: HerdrTestTransport): void {
  testTransport = transport;
}

export function resolveHerdrSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH?.trim()) return process.env.HERDR_SOCKET_PATH.trim();
  const configRoot = process.env.XDG_CONFIG_HOME?.trim()
    ? join(process.env.XDG_CONFIG_HOME.trim(), "herdr")
    : join(homedir(), ".config", "herdr");
  const session = process.env.HERDR_SESSION?.trim();
  return session ? join(configRoot, "sessions", session, "herdr.sock") : join(configRoot, "herdr.sock");
}

export function requestHerdrSocket(
  method: string,
  params: Record<string, unknown>,
  timeout: number,
  socketPath = resolveHerdrSocketPath(),
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `pi-routing:${process.pid}:${Date.now()}:${requestSequence++}`;
    const request = `${JSON.stringify({ id, method, params })}\n`;
    let settled = false;
    let buffered = "";
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");

    const finish = (error?: Error, response?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(response);
    };
    const timer = setTimeout(() => finish(new Error(`herdr_socket_timeout: ${method} timed out after ${timeout}ms`)), timeout);

    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_SOCKET_RESPONSE_BYTES) {
        finish(new Error(`herdr_response_too_large: ${method} exceeded ${MAX_SOCKET_RESPONSE_BYTES} bytes`));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline).trim();
      let response: any;
      try { response = JSON.parse(line); }
      catch { finish(new Error(`herdr_invalid_response: ${method} returned invalid JSON: ${line.slice(0, 300)}`)); return; }
      if (response?.id !== id) {
        finish(new Error(`herdr_response_mismatch: ${method} returned response id ${JSON.stringify(response?.id)}`));
        return;
      }
      if (response?.error) {
        finish(new Error(`${response.error.code ?? "herdr_error"}: ${response.error.message ?? "Herdr request failed"}`));
        return;
      }
      if (!response?.result) {
        finish(new Error(`herdr_invalid_response: ${method} returned no result`));
        return;
      }
      finish(undefined, response);
    });
    socket.once("error", (error) => finish(new Error(`herdr_socket_error: ${method}: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) finish(new Error(`herdr_empty_response: ${method} closed without a response`));
    });
  });
}

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const repeatedOptions = (args: string[], name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!);
  return values;
};

const envOptions = (args: string[]) => Object.fromEntries(repeatedOptions(args, "--env").map((entry) => {
  const separator = entry.indexOf("=");
  return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
}));

const metadataTokens = (args: string[]) => ({
  ...Object.fromEntries(repeatedOptions(args, "--token").map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  })),
  ...Object.fromEntries(repeatedOptions(args, "--clear-token").map((key) => [key, null])),
});

export function herdrSocketRequestForArgs(args: string[]): HerdrSocketRequest {
  const command = args.slice(0, 2).join(" ");
  const target = args[2];
  switch (command) {
    case "tab list": return { method: "tab.list", params: { workspace_id: option(args, "--workspace") } };
    case "tab create": return { method: "tab.create", params: { workspace_id: option(args, "--workspace"), cwd: option(args, "--cwd"), focus: !args.includes("--no-focus"), label: option(args, "--label"), env: envOptions(args) } };
    case "tab close": return { method: "tab.close", params: { tab_id: target } };
    case "pane list": return { method: "pane.list", params: { workspace_id: option(args, "--workspace") } };
    case "pane layout": return { method: "pane.layout", params: { pane_id: option(args, "--pane") ?? target } };
    case "pane focus": return { method: "pane.focus", params: { pane_id: target } };
    case "pane split": return { method: "pane.split", params: { target_pane_id: option(args, "--pane"), direction: option(args, "--direction"), cwd: option(args, "--cwd"), focus: !args.includes("--no-focus"), env: envOptions(args) } };
    case "pane close": return { method: "pane.close", params: { pane_id: target } };
    case "pane report-agent-session": return { method: "pane.report_agent_session", params: {
      pane_id: target, source: option(args, "--source"), agent: option(args, "--agent"),
      agent_session_path: option(args, "--agent-session-path"), session_start_source: option(args, "--session-start-source"),
    } };
    case "pane report-metadata": return {
      method: "pane.report_metadata",
      params: {
        pane_id: target,
        source: option(args, "--source"),
        agent: option(args, "--agent"),
        applies_to_source: option(args, "--applies-to-source"),
        display_agent: option(args, "--display-agent"),
        clear_display_agent: args.includes("--clear-display-agent"),
        tokens: metadataTokens(args),
      },
    };
    case "agent list": return { method: "agent.list", params: {} };
    case "agent get": return { method: "agent.get", params: { target } };
    case "agent focus": return { method: "agent.focus", params: { target } };
    case "agent read": return { method: "agent.read", params: { target, source: (option(args, "--source") ?? "recent-unwrapped").replaceAll("-", "_"), lines: Number(option(args, "--lines") ?? 80), format: "text", strip_ansi: true }, textResult: (response) => String(response?.result?.read?.text ?? "") };
    case "agent send-keys": return { method: "agent.send_keys", params: { target, keys: args.slice(3) } };
    case "agent wait": return { method: "agent.wait", params: { target, until: repeatedOptions(args, "--until"), timeout_ms: Number(option(args, "--timeout") ?? 0) || undefined } };
    case "agent prompt": {
      const wait = args.includes("--wait") ? { until: repeatedOptions(args, "--until"), timeout_ms: Number(option(args, "--timeout") ?? 0) || undefined } : undefined;
      return { method: "agent.prompt", params: { target, text: args[3] ?? "", wait } };
    }
    case "agent start": {
      const separator = args.indexOf("--");
      return { method: "agent.start", params: { name: target, kind: option(args, "--kind"), pane_id: option(args, "--pane"), timeout_ms: Number(option(args, "--timeout") ?? 30_000), args: separator >= 0 ? args.slice(separator + 1) : [] } };
    }
    default: throw new Error(`Unsupported Herdr socket command: ${command}`);
  }
}

/**
 * Raw socket transport for the routing extension. The CLI-shaped argument list is retained
 * internally to keep call sites compact; production requests never spawn the Herdr CLI.
 */
export async function runHerdr(pi: ExtensionAPI, args: string[], timeout: number): Promise<string> {
  if (testTransport) return testTransport(pi, args, timeout);
  const request = herdrSocketRequestForArgs(args);
  const response = await requestHerdrSocket(request.method, request.params, timeout);
  return request.textResult ? request.textResult(response) : JSON.stringify(response);
}

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
export function verifyTaskAgent(task: TaskHandle, agent: any): void {
  if (!task.terminalId || agent?.pane_id !== task.paneId || agent.terminal_id !== task.terminalId) throw new Error("Worker terminal identity is unverified or replaced");
  const sessionId = readHerdrSessionId(agent?.agent_session?.value);
  if (!sessionId || (task.sessionId && sessionId !== task.sessionId)) throw new Error("Worker Pi session identity is unverified or replaced");
  if (!task.sessionId) task.sessionId = sessionId;
}

export async function proveTaskAbsent(pi: ExtensionAPI, task: TaskHandle): Promise<boolean> {
  if (!task.paneId || !task.terminalId || !task.sessionId) throw new Error("Original executor identity is incomplete; absence is unverified");
  const agents = parseJson(await runHerdr(pi, ["agent", "list"], 5000), "herdr agent inventory")?.result?.agents;
  if (!Array.isArray(agents)) throw new Error("Agent inventory is incomplete; absence is unverified");
  return !agents.some((agent: any) => agent.pane_id === task.paneId || agent.terminal_id === task.terminalId || readHerdrSessionId(agent.agent_session?.value) === task.sessionId);
}

/** Reconcile only proven-exited executors; registry failure alone never authorizes a second writer. */
export async function recoverAbsentTask(pi: ExtensionAPI, task: TaskHandle): Promise<Partial<TaskHandle> | undefined> {
  try {
    if (!task.paneId || !task.sessionId || !task.assignmentId || task.pendingCompletion) return undefined;
    const agents = parseJson(await runHerdr(pi, ["agent", "list"], 5000), "recovery inventory")?.result?.agents;
    if (!Array.isArray(agents) || agents.some((agent: any) => agent.pane_id === task.paneId ||
      (task.terminalId && agent.terminal_id === task.terminalId) || agent.name === task.agentName ||
      readHerdrSessionId(agent.agent_session?.value) === task.sessionId || (agent.agent === "pi" && agent.launch_pending))) return undefined;
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
    const panes = parseJson(await runHerdr(pi, ["pane", "list"], 5000), "startup recovery inventory")?.result?.panes;
    if (!Array.isArray(panes) || panes.some((pane: any) => pane.pane_id === task.paneId)) return undefined;
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
        const agent = parseJson(await runHerdr(pi, ["agent", "get", task.agentName!], 5000), "herdr agent get")?.result?.agent;
        if (!watching()) return;
        verifyTaskAgent(task, agent);
        const status = String(agent.agent_status);
        updateUsage(agent.agent_session?.value);
        errors = 0;
        const state = ask || status === "blocked" ? "blocked" : status === "working" || task.background ? "running" : receipt && receipt.requestId === task.requestId && receipt.outcome === "aborted" ? "interrupted" : "unknown";
        update({ state, presence: "live" }, task.state !== state || task.presence !== "live");
        if (ask) options.question?.(ask);
        else if (state === "blocked") notify(`blocked#${receipt?.generation ?? 0}`, `Subagent ${task.handle} is blocked; supply the missing decision with steer.`);
        const activity = receipt?.lastActivityAt ?? task.startedAt;
        if (state === "running" && Date.now() - activity >= 10 * 60_000 && staleEpisode !== activity) {
          staleEpisode = activity;
          const evidence = await runHerdr(pi, ["agent", "read", task.agentName!, "--source", "recent-unwrapped", "--lines", "20"], 2000).catch(() => "Live diagnostic unavailable");
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

const isHerdrAgentReady = (agent: any): boolean => {
  if (!agent || agent.launch_pending === true) return false;
  if (agent.interactive_ready === true) return true;
  // A freshly started Pi agent passes through idle while launch_pending is still set.
  // Require explicit interactive readiness for idle; working/done/blocked are concrete
  // evidence that the agent has already accepted input.
  return ["working", "done", "blocked"].includes(String(agent.agent_status ?? ""));
};

export async function waitForHerdrAgentReady(pi: ExtensionAPI, agentName: string, timeout = HERDR_AGENT_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastState = "no agent state";
  let observedAgent = false;
  while (Date.now() < deadline) {
    try {
      const raw = await runHerdr(pi, ["agent", "get", agentName], 5000);
      const agent = parseJson(raw, "herdr agent get after start")?.result?.agent;
      observedAgent ||= !!agent;
      const status = String(agent?.agent_status ?? "unknown");
      lastState = `status=${status} launch_pending=${String(agent?.launch_pending)} interactive_ready=${String(agent?.interactive_ready)}`;
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

export async function launchHerdrAgent(pi: ExtensionAPI, task: string, description: string, routeName: string, route: Route, cwd: string, readyTimeout = HERDR_AGENT_READY_TIMEOUT_MS, manifestPath?: string, capabilities: RoutedWorkerCapability[] = [], background = false, options: { assignmentId?: string; readonly?: boolean; continuation?: { path: string; id: string }; onAllocated?: (launch: HerdrLaunch) => void; onStarted?: (launch: HerdrLaunch) => void } = {}): Promise<HerdrLaunch> {
  let allocation: PaneAllocation;
  try { allocation = await allocateRoutedAgentPane(pi, cwd, manifestPath, background, options.assignmentId, options.readonly); }
  catch (error) { throw orchestrationError(error, "launch", { stage: "pane_allocation", retrySafe: "unknown", nextAction: "Inspect allocation evidence before retrying; no guessed pane or tab was removed." }); }
  const { paneId, tabId } = allocation;
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "task";
  const agent = `r-${slug}-${Date.now().toString(36).slice(-5)}`.slice(0, 32);
  let started = false;
  let attempted = false;
  let retryAttempted = false;
  let stage = "agent_start";
  try {
    stage = "allocation_record";
    options.onAllocated?.({ agent, paneId, tabId, route: routeName, sessionId: options.continuation?.id ?? options.assignmentId, sessionPath: options.continuation?.path });
    stage = "agent_start";
    const startArgs = ["agent", "start", agent, "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", ...buildRoutedWorkerPiArgs(description, route, capabilities, options.readonly, options.assignmentId, options.continuation)];
    let lastStartError: unknown;
    for (const delay of [150, 350, 750, 1500]) {
      await sleep(delay, new AbortController().signal);
      try {
        attempted = true;
        const startRaw = await runHerdr(pi, startArgs, 40000);
        started = true;
        const startedAgent = parseJson(startRaw, "herdr agent start")?.result?.agent;
        // Herdr 0.8.0's socket method acknowledges agent.start as soon as the process
        // launches, often several seconds before the name is prompt-ready. The CLI waits
        // for this transition internally; the direct socket transport must do the same.
        stage = "interactive_readiness";
        if (!isHerdrAgentReady(startedAgent)) await waitForHerdrAgentReady(pi, agent, readyTimeout);
        break;
      }
      catch (error) { lastStartError = error; if (!/agent_pane_busy/.test(error instanceof Error ? error.message : String(error))) throw error; attempted = false; retryAttempted = true; }
    }
    if (!started) throw lastStartError ?? new Error("Herdr pane did not become available");
    stage = "executor_identity";
    const info = parseJson(await runHerdr(pi, ["agent", "get", agent], 5000), "started worker identity")?.result?.agent;
    const sessionPath = info?.agent_session?.value;
    const launch: HerdrLaunch = { agent, paneId, tabId, route: routeName, terminalId: info?.terminal_id, sessionPath, sessionId: readHerdrSessionId(sessionPath) ?? options.continuation?.id ?? options.assignmentId };
    if (options.continuation && (launch.sessionId !== options.continuation.id || (!sessionPath || realpathSync(sessionPath) !== realpathSync(options.continuation.path)))) throw new Error("Continuation started with conflicting saved-session identity");
    options.onStarted?.(launch);
    const contract = background
      ? "Background contract: you are a long-lived background subagent. The parent agent never receives your output automatically and may later read your latest reply, so end each turn with a short current-status summary. Own only this assignment; do not delegate. Use notify_user (Telegram) only when the user must act or when something important finished."
      : "Task contract: own only this assignment; do not broaden scope or delegate. Report the outcome, changed artifacts or findings, evidence actually observed, and concrete blockers or risks. Use ask_parent for a missing decision that blocks this assignment; do not finish with an unanswered question.";
    const prompt = [...(options.assignmentId ? [`p3:routed-request ${options.assignmentId}`] : []), task, "", contract].join("\n");
    if (options.assignmentId) saveRoutedInstruction(options.assignmentId, options.assignmentId, prompt);
    stage = "task_submission";
    // One socket request both submits and observes the first working transition. If Herdr
    // 0.8.0's delayed Enter is swallowed, submit only the existing composer text and verify
    // activity; never paste the prompt twice.
    try {
      await runHerdr(pi, [
        "agent", "prompt", agent, prompt, "--wait",
        "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "7000",
      ], 10000);
    } catch (error) {
      if (!/agent_prompt_stalled/.test(error instanceof Error ? error.message : String(error))) throw error;
      await runHerdr(pi, ["agent", "send-keys", agent, "enter"], 5000);
      try {
        await runHerdr(pi, [
          "agent", "wait", agent, "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "5000",
        ], 7000);
      } catch (recoveryError) {
        // A very fast task can settle before the follow-up wait attaches. Accept concrete
        // lifecycle/result evidence; otherwise preserve the started pane for inspection.
        const raw = await runHerdr(pi, ["agent", "get", agent], 5000).catch(() => undefined);
        const info = raw ? parseJson(raw, "herdr agent get")?.result?.agent : undefined;
        const result = readHerdrResult(info?.agent_session?.value);
        if (!(info?.agent_status === "working" || info?.agent_status === "done" || info?.agent_status === "blocked" || result)) throw recoveryError;
      }
    }
    return launch;
  } catch (error) {
    const ids = { agent, paneId, tabId, assignmentId: options.assignmentId, sessionId: options.continuation?.id ?? options.assignmentId };
    if (started || attempted || retryAttempted) throw orchestrationError(error, "launch", { category: "ambiguous_startup", stage, ids, retryAttempted, retrySafe: "unknown",
      nextAction: "Inspect the retained exact pane/session before retrying; startup or submission may have acted. No prompt was replayed or replacement started." });
    let cleanupError: unknown;
    try {
      const panes = parseJson(await runHerdr(pi, ["pane", "list", "--workspace", rootContext().workspaceId], 5000), "rollback topology")?.result?.panes;
      if (!Array.isArray(panes) || !panes.some((pane: any) => pane.pane_id === paneId)) throw new Error("Original rollback pane could not be verified");
      // Another assignment may already have split this tab; roll back only this pane.
      await runHerdr(pi, ["pane", "close", paneId], 5000);
    } catch (failure) { cleanupError = failure; }
    throw orchestrationError(error, "launch", { stage, ids, retryAttempted, rollbackOccurred: !cleanupError, retrySafe: !cleanupError,
      primary: { message: error instanceof Error ? error.message : String(error) }, ...(cleanupError ? { cleanup: { message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) } } : {}),
      nextAction: cleanupError ? "Inspect both startup and cleanup failures before retrying; retained resources are not guessed away." : "The exact fresh pane was rolled back before launch; resolve the startup failure before retrying." });
  }
}
