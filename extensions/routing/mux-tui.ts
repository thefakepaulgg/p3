import { orchestrationError } from "./errors.ts";
import { parseJson, requestHerdrSocket, runHerdr } from "./herdr-socket.ts";
import type { CreateTabOptions, Mux, MuxAgent, MuxPane, WorkerPane, WorkerPaneOptions, WorktreePlacement, WorktreeRequest, WorktreeSource } from "./mux.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Herdr TUI backend: the only place that builds Herdr CLI-shaped requests or parses TUI-shaped results.

export const ROUTED_TAB_MAX_PANES = 4;
const ROUTED_TAB_LABEL = "Subagents";
let allocationTail: Promise<void> = Promise.resolve();

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

async function allocateRoutedAgentPane(pi: ExtensionAPI, cwd: string, { manifestPath, background = false, assignmentId, readonly = false }: WorkerPaneOptions = {}): Promise<WorkerPane> {
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

const tuiAgent = (raw: any): MuxAgent | undefined => raw ? normalizeTuiAgent(raw) : undefined;

/** TUI `agent.get` payload → neutral record. Accepts the raw shape so callers holding one stay valid. */
export const normalizeTuiAgent = (raw: any): MuxAgent => ({
  id: raw.pane_id ?? raw.name ?? "", name: raw.name, kind: raw.agent, paneId: raw.pane_id, terminalId: raw.terminal_id, workspaceId: raw.workspace_id,
  status: String(raw.agent_status ?? "unknown"), sessionPath: raw.agent_session?.value,
  launchPending: raw.launch_pending, interactiveReady: raw.interactive_ready, raw,
});

const AWAIT_START = ["--wait", "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "7000"];

export const tuiMux: Mux = {
  backend: "tui",
  async getAgent(pi, target) {
    return tuiAgent(parseJson(await runHerdr(pi, ["agent", "get", target], 5000), "herdr agent get")?.result?.agent);
  },
  async listAgents(pi) {
    const agents = parseJson(await runHerdr(pi, ["agent", "list"], 5000), "herdr agent list")?.result?.agents;
    return Array.isArray(agents) ? agents.map(normalizeTuiAgent) : undefined;
  },
  async startAgent(pi, name, paneId, args) {
    return tuiAgent(parseJson(await runHerdr(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", ...args], 40000), "herdr agent start")?.result?.agent);
  },
  async prompt(pi, target, text, opts) {
    await runHerdr(pi, ["agent", "prompt", target, text, ...(opts?.awaitStart ? AWAIT_START : [])], 10000);
  },
  async sendKeys(pi, target, keys) { await runHerdr(pi, ["agent", "send-keys", target, ...keys], 5000); },
  async wait(pi, target, until, timeoutMs) {
    await runHerdr(pi, ["agent", "wait", target, ...until.flatMap((state) => ["--until", state]), "--timeout", String(timeoutMs)], timeoutMs + 2000);
  },
  read(pi, target, lines) { return runHerdr(pi, ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)], 2000); },
  async focusPane(pi, paneId) { await runHerdr(pi, ["pane", "focus", paneId], 5000); },
  async listPanes(pi, workspaceId) {
    const panes = parseJson(await runHerdr(pi, ["pane", "list", ...(workspaceId !== undefined ? ["--workspace", workspaceId] : [])], 5000), "herdr pane list")?.result?.panes;
    return Array.isArray(panes) ? panes.map((pane: any): MuxPane => ({ paneId: pane.pane_id, tabId: pane.tab_id })) : undefined;
  },
  async closePane(pi, paneId) { await runHerdr(pi, ["pane", "close", paneId], 5000); },
  async closeTab(pi, tabId) { await runHerdr(pi, ["tab", "close", tabId], 5000); },
  async createTab(pi, { workspaceId, cwd, label, env = {}, focus }: CreateTabOptions) {
    const created = parseJson(await runHerdr(pi, ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), ...(focus ? [] : ["--no-focus"])], 10000), "herdr tab create");
    return { paneId: created?.result?.root_pane?.pane_id, tabId: created?.result?.tab?.tab_id };
  },
  allocateWorkerPane: allocateRoutedAgentPane,
  async reportSession(pi, paneId, sessionPath, sequence, startSource) {
    await runHerdr(pi, ["pane", "report-agent-session", paneId, "--source", "herdr:pi", "--agent", "pi", "--seq", String(sequence), "--agent-session-path", sessionPath,
      ...(startSource ? ["--session-start-source", startSource] : [])], 5000);
  },
  async reportMetadata(pi, paneId, source, tokens) {
    await runHerdr(pi, ["pane", "report-metadata", paneId, "--source", source,
      ...Object.entries(tokens).flatMap(([key, value]) => value === null ? ["--clear-token", key] : ["--token", `${key}=${value}`])], 5000);
  },
  async worktreeList(_pi, request): Promise<WorktreeSource> {
    const listed = await requestHerdrSocket("worktree.list", request.cwd !== undefined ? { cwd: request.cwd } : { workspace_id: request.workspaceId }, 5000);
    const source = listed.result.source as { source_workspace_id?: string; repo_root: string };
    return { repoRoot: source.repo_root, sourceWorkspaceId: source.source_workspace_id };
  },
  async worktreeOpen(_pi, action, request: WorktreeRequest): Promise<WorktreePlacement> {
    const response = await requestHerdrSocket(`worktree.${action}`, {
      ...(request.workspaceId ? { workspace_id: request.workspaceId } : request.cwd ? { cwd: request.cwd } : {}),
      ...(request.branch ? { branch: request.branch } : {}),
      ...(request.path ? { path: request.path } : {}),
      ...(request.label !== undefined ? { label: request.label } : {}),
      focus: false,
    }, 120000);
    const placed = response.result;
    return { workspaceId: placed.workspace.workspace_id, rootPaneId: placed.root_pane.pane_id, worktreePath: placed.worktree.path, alreadyOpen: !!placed.already_open };
  },
};
