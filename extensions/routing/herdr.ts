import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Route } from "./policy.ts";
import { buildCompletionMessage, COMPLETION_KIND, isActiveTask, type TaskHandle } from "./state.ts";
import { readIncrementalUsage } from "./usage.ts";

export type RoutedWorkerCapability = "memory";

export interface HerdrLaunch { agent: string; paneId: string; tabId: string; route: string }

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

export async function allocateRoutedAgentPane(pi: ExtensionAPI, cwd: string, manifestPath?: string, background = false): Promise<PaneAllocation> {
  return withAllocationLock(async () => {
    const { workspaceId, rootTabId } = rootContext();
    const manifestEnv = [
      ...(manifestPath ? ["--env", `PI_ROUTING_MANIFEST=${manifestPath}`] : []),
      ...(background ? ["--env", "PI_SUBAGENT_MODE=background"] : []),
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
        if (tabId) await runHerdr(pi, ["tab", "close", tabId], 5000).catch(() => undefined);
        throw new Error("Herdr tab creation succeeded without returning a tab and root pane ID");
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

export function readHerdrResult(sessionPath?: string): string {
  if (!sessionPath || !existsSync(sessionPath)) return "";
  const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      const message = entry?.type === "message" ? entry.message : undefined;
      if (message?.role !== "assistant") continue;
      const text = Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
        : typeof message.content === "string" ? message.content : "";
      if (text.trim()) return text.trim();
    } catch { /* ignore incomplete JSONL tail */ }
  }
  return "";
}

export const shouldCloseCompletedPane = (retention?: "keep" | "close") => retention === "close";

export const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function watchHerdrTask(options: {
  pi: ExtensionAPI;
  task: TaskHandle;
  watchers: Map<string, AbortController>;
  baselineResult?: string;
  update: (patch: Partial<TaskHandle>, persist?: boolean) => void;
  persist: () => void;
  notify: (kind: string, content: string) => void;
}): void {
  const { pi, task, watchers, update, persist, notify, baselineResult = "" } = options;
  const controller = new AbortController();
  watchers.set(task.handle, controller);
  void (async () => {
    let sawWorking = false;
    let blockedNotified = false;
    let advisoryNotified = false;
    let consecutivePollErrors = 0;
    const advisoryAt = Date.now() + 30 * 60_000;
    const shouldWatch = () => !controller.signal.aborted && isActiveTask(task);
    while (shouldWatch()) {
      try {
        const agent = parseJson(await runHerdr(pi, ["agent", "get", task.agentName!], 5000), "herdr agent get")?.result?.agent;
        if (!shouldWatch()) return;
        const status = agent?.agent_status as string | undefined;
        const sessionPath = agent?.agent_session?.value as string | undefined;
        const result = readHerdrResult(sessionPath);
        const usage = readIncrementalUsage(sessionPath, {
          sessionPath: task.sessionPath,
          offset: task.usageOffset ?? 0,
          cost: task.estimatedCost ?? 0,
          costKnown: task.costKnown ?? false,
        });
        if (usage.changed) update({ sessionPath: usage.sessionPath, usageOffset: usage.offset, estimatedCost: usage.cost, costKnown: usage.costKnown }, false);
        consecutivePollErrors = 0;
        if (status === "working") { sawWorking = true; blockedNotified = false; update({ state: "running" }, task.state !== "running"); }
        else if (status === "blocked") {
          update({ state: "blocked" }, task.state !== "blocked");
          if (!blockedNotified) {
            blockedNotified = true;
            const episode = (task.blockedEpisodes ?? 0) + 1;
            update({ blockedEpisodes: episode }, false);
            notify(`blocked#${episode}`, `Subagent ${task.handle} is blocked (${task.label}). ${task.escalation ?? "Inspect or steer the agent."}`);
          }
        } else if (task.background) {
          // Background subagents idle between self-triggered turns; idle is not completion.
          if (task.state !== "running") update({ state: "running" });
        } else if ((status === "idle" || status === "done") && (sawWorking || (!!result && result !== baselineResult))) {
          update({ state: "completed", endedAt: Date.now(), resultChars: result.length, result });
          if (shouldCloseCompletedPane(task.paneRetention) && task.paneId && !task.paneClosedAt) {
            const closed = await runHerdr(pi, ["pane", "close", task.paneId], 5000).then(() => true).catch(() => false);
            if (closed) update({ paneClosedAt: Date.now() }, false);
          }
          notify(COMPLETION_KIND, buildCompletionMessage(task, result));
          return;
        }
      } catch (error) {
        if (!shouldWatch()) return;
        const message = error instanceof Error ? error.message : String(error);
        if (/agent_not_found/.test(message)) { update({ state: "abandoned", endedAt: Date.now(), error: message }); notify("abandoned", `Subagent ${task.handle} disappeared before completion. ${task.escalation ?? ""}`); return; }
        consecutivePollErrors += 1;
      }
      if (!task.background && !advisoryNotified && Date.now() >= advisoryAt) {
        advisoryNotified = true;
        task.escalation = "The Herdr task has run for more than 30 minutes; it remains watched and was not stopped.";
        persist();
        notify("long-running", `Subagent ${task.handle} is still running after 30 minutes. It remains active and monitored in pane ${task.paneId}.`);
      }
      const pollDelay = consecutivePollErrors === 0 ? 1000 : Math.min(10_000, 1000 * 2 ** Math.min(consecutivePollErrors, 4));
      await sleep(pollDelay, controller.signal);
    }
  })().finally(() => { if (watchers.get(task.handle) === controller) watchers.delete(task.handle); });
}

const HERDR_AGENT_READY_TIMEOUT_MS = 30_000;

export function buildRoutedWorkerPiArgs(description: string, route: Route, _capabilities: RoutedWorkerCapability[] = []): string[] {
  return [
    "--exclude-tools", "subagent,subagent_control,model_route,workflow_control",
    "--model", `${route.provider}/${route.model}`,
    "--thinking", route.thinking,
    "--name", description,
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

async function waitForHerdrAgentReady(pi: ExtensionAPI, agentName: string, timeout = HERDR_AGENT_READY_TIMEOUT_MS): Promise<void> {
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

export async function launchHerdrAgent(pi: ExtensionAPI, task: string, description: string, routeName: string, route: Route, cwd: string, readyTimeout = HERDR_AGENT_READY_TIMEOUT_MS, manifestPath?: string, capabilities: RoutedWorkerCapability[] = [], background = false): Promise<HerdrLaunch> {
  const allocation = await allocateRoutedAgentPane(pi, cwd, manifestPath, background);
  const { paneId, tabId } = allocation;
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "task";
  const agent = `r-${slug}-${Date.now().toString(36).slice(-5)}`.slice(0, 32);
  let started = false;
  try {
    const startArgs = ["agent", "start", agent, "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", ...buildRoutedWorkerPiArgs(description, route, capabilities)];
    let lastStartError: unknown;
    for (const delay of [150, 350, 750, 1500]) {
      await sleep(delay, new AbortController().signal);
      try {
        const startRaw = await runHerdr(pi, startArgs, 40000);
        started = true;
        const startedAgent = parseJson(startRaw, "herdr agent start")?.result?.agent;
        // Herdr 0.8.0's socket method acknowledges agent.start as soon as the process
        // launches, often several seconds before the name is prompt-ready. The CLI waits
        // for this transition internally; the direct socket transport must do the same.
        if (!isHerdrAgentReady(startedAgent)) await waitForHerdrAgentReady(pi, agent, readyTimeout);
        break;
      }
      catch (error) { lastStartError = error; if (!/agent_pane_busy/.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
    if (!started) throw lastStartError ?? new Error("Herdr pane did not become available");
    const contract = background
      ? "Background contract: you are a long-lived background subagent. The parent agent never receives your output automatically and may later read your latest reply, so end each turn with a short current-status summary. Own only this assignment; do not delegate. Use notify_user (Telegram) only when the user must act or when something important finished."
      : "Task contract: own only this assignment; do not broaden scope or delegate. Report the outcome, changed artifacts or findings, evidence actually observed, and concrete blockers or risks. Stop if a missing decision materially changes the outcome.";
    const prompt = [task, "", contract].join("\n");
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
    return { agent, paneId, tabId, route: routeName };
  } catch (error) {
    if (started) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}. Started agent pane ${paneId} was retained for inspection.`);
    }
    const cleanup = allocation.createdTab ? ["tab", "close", tabId] : ["pane", "close", paneId];
    await runHerdr(pi, cleanup, 5000).catch(() => undefined);
    throw error;
  }
}
