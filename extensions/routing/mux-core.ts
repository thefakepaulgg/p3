import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CoreRpcError, requestCore } from "./core-socket.ts";
import type { CreateTabOptions, Mux, MuxAgent, MuxPane, WorkerLaunchRequest, WorktreePlacement, WorktreeRequest, WorktreeSource } from "./mux.ts";

// Herdr Core backend. A worker is a core terminal: the agent id, "pane id" and terminal id are all
// the terminal address (`t7`, stable for the life of the core). Status comes from the program's own
// OSC 7501 reports; identity that core cannot know (the Pi session file) is published as labels.

export const LABEL_HANDLE = "p3.handle";
export const LABEL_SESSION = "p3.session";
export const LABEL_ASSIGNMENT = "p3.assignment";
/** The Herdr App shows a core terminal carrying both of these (an id it does not know becomes a new space/tab). */
export const LABEL_SPACE = "herdr.space";
export const LABEL_TAB = "herdr.tab";
/** p3's own placement bookkeeping, set even when there is no App placement, so a tab's terminals can always be found. */
export const LABEL_P3_TAB = "p3.tab";
export const LABEL_BRANCH = "p3.branch";
export const LABEL_WORKTREE = "p3.worktree";
/** A request, as a millisecond timestamp, for Herdr App clients to show this terminal; core itself has no focus. */
export const LABEL_FOCUS = "p3.focus";

const callerId = () => process.env.HC_TERMINAL_ID || undefined;

/** `not_found` and finished terminals both mean "no such live agent" to the shared watch/recovery logic. */
const call = async (method: string, params: Record<string, unknown>, timeout = 10_000): Promise<any> => {
  try { return await requestCore(method, params, timeout); }
  catch (error) {
    if (error instanceof CoreRpcError && error.kind === "not_found") throw new Error(`agent_not_found: ${error.message}`);
    throw error;
  }
};

export const normalizeCoreTerminal = (raw: any): MuxAgent => {
  const labels: Record<string, string> = raw.labels ?? {};
  const address = String(raw.address);
  const isPi = labels[LABEL_HANDLE] !== undefined || labels[LABEL_SESSION] !== undefined;
  // Ready once the program has reported a status and published its session identity.
  const ready = !!raw.status && labels[LABEL_SESSION] !== undefined;
  return {
    id: address, name: raw.name ?? undefined, kind: isPi ? "pi" : undefined, paneId: address, terminalId: address,
    workspaceId: labels[LABEL_SPACE], tabId: labels[LABEL_TAB],
    status: String(raw.status?.state ?? (raw.state === "finished" ? "exited" : "unknown")),
    sessionPath: labels[LABEL_SESSION], launchPending: isPi ? !ready : undefined, interactiveReady: isPi ? ready : undefined, raw,
  };
};

const getTerminal = async (target: string): Promise<any> => {
  const terminal = await call("terminal.get", { terminal: target });
  if (terminal.state === "finished") throw new Error(`agent_not_found: terminal ${terminal.address} has finished (${terminal.reason ?? "exited"}, exit code ${terminal.exit_code ?? "n/a"})`);
  return terminal;
};

/**
 * A core terminal's PATH is the one the core was started with, which may not contain `pi`: resolve it
 * through this session's PATH (which found it) and pass the absolute path. Falls back to the bare name.
 */
const piExecutable = (): string => {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    try { accessSync(join(dir, "pi"), constants.X_OK); return join(dir, "pi"); } catch { /* next */ }
  }
  return "pi";
};

// Placements reserved by createTab / worktreeOpen, consumed by startAgent. Core has no pre-created pane.
interface Slot { tabId: string; cwd: string; env?: Record<string, string>; labels: Record<string, string> }
const slots = new Map<string, Slot>();

/** A new tab id inside `space`; without a space the terminal gets no App placement (sidebar only). */
const reserve = (space: string | undefined, tab: string | undefined, cwd: string, env?: Record<string, string>, labels: Record<string, string> = {}) => {
  const tabId = tab ?? `p3t-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const token = `slot:${randomUUID()}`;
  slots.set(token, { tabId, cwd, env, labels: { ...labels, [LABEL_P3_TAB]: tabId, ...(space ? { [LABEL_SPACE]: space, [LABEL_TAB]: tabId } : {}) } });
  return { paneId: token, tabId };
};

const git = async (pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> => {
  const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};

const safeRealpath = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Main checkout of the repository containing `cwd` (works from linked worktrees). */
const repoRoot = async (pi: ExtensionAPI, cwd: string): Promise<string> => {
  const common = await git(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return basename(common) === ".git" ? dirname(common) : await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
};

const worktreeEntries = async (pi: ExtensionAPI, root: string): Promise<Array<{ path: string; branch?: string }>> => {
  const entries: Array<{ path: string; branch?: string }> = [];
  for (const block of (await git(pi, root, ["worktree", "list", "--porcelain"])).split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (path) entries.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] });
  }
  return entries;
};

/** The App's convention: `~/.herdr/worktrees/<repo>/<branch>`, a slashed branch folded into one folder name. */
const defaultWorktreePath = (root: string, branch: string) =>
  join(process.env.HOME || homedir(), ".herdr", "worktrees", basename(root), branch.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch");

/** Space of a live terminal already serving this checkout (its label, else its launch folder). */
const liveSpaceFor = async (worktreePath: string): Promise<string | undefined> => {
  const listed = await call("terminal.list", {});
  for (const terminal of listed?.terminals ?? []) {
    const labels: Record<string, string> = terminal.labels ?? {};
    if (labels[LABEL_SPACE] && (labels[LABEL_WORKTREE] === worktreePath || (terminal.cwd && safeRealpath(terminal.cwd) === worktreePath))) return labels[LABEL_SPACE];
  }
  return undefined;
};

// Published once per (terminal, value): Pi re-reports the same session on every turn.
const publishedSession = new Map<string, string>();

export const coreMux: Mux = {
  backend: "core",
  async getAgent(_pi, target) { return normalizeCoreTerminal(await getTerminal(target)); },
  async listAgents() {
    const listed = await call("terminal.list", {});
    return Array.isArray(listed?.terminals) ? listed.terminals.map(normalizeCoreTerminal) : undefined;
  },
  async prompt(_pi, target, text, opts) {
    // Core types the text once nobody has typed for ~3s and refuses a blocked program; both surface as errors.
    // No `caller`: core would wrap a terminal sender's text in <hc from="..."> tags, and p3's own
    // `p3:routed-request` marker must stay the first line of the prompt the worker receives.
    const sent = await call("terminal.send", { terminal: target, text }, 20_000);
    if (opts?.awaitStart && sent?.started === false) throw new Error(`agent_prompt_stalled: ${target} did not start working after the prompt was submitted`);
  },
  async sendKeys(_pi, target, keys) { await call("terminal.keys", { terminal: target, keys }, 10_000); },
  async wait(_pi, target, until, timeoutMs) {
    // terminal.wait ends on "not working"; callers here wait for specific states, so observe them directly.
    const deadline = Date.now() + timeoutMs;
    let last = "no status";
    for (;;) {
      const terminal = await call("terminal.get", { terminal: target });
      const state = terminal.status?.state as string | undefined;
      if (state && until.includes(state)) return;
      if (terminal.state === "finished") throw new Error(`agent_not_found: terminal ${terminal.address} finished while waiting`);
      last = state ?? "no status";
      if (Date.now() >= deadline) throw new Error(`agent_wait_timeout: ${target} stayed ${last} for ${timeoutMs}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  },
  async read(_pi, target, lines) { return String((await call("terminal.read", { terminal: target, lines }, 5000))?.text ?? ""); },
  async focusPane(_pi, paneId) { await call("terminal.label", { terminal: paneId, labels: { [LABEL_FOCUS]: String(Date.now()) } }); return undefined; },
  async listPanes(_pi, workspaceId) {
    const listed = await call("terminal.list", workspaceId ? { labels: { [LABEL_SPACE]: workspaceId } } : {});
    return Array.isArray(listed?.terminals)
      ? listed.terminals.map((terminal: any): MuxPane => ({ paneId: String(terminal.address), tabId: terminal.labels?.[LABEL_P3_TAB] ?? terminal.labels?.[LABEL_TAB] }))
      : undefined;
  },
  // A worker "pane" is its terminal: closing it ends the program and removes the record.
  async closePane(_pi, paneId) {
    await call("terminal.kill", { terminal: paneId }, 15_000);
    await call("terminal.rm", { terminal: paneId });
  },
  // Core cannot close a tab or space: a tab is closed by ending its terminals (the App drops empty panes and tabs).
  async closeTab(_pi, tabId) {
    const listed = await call("terminal.list", { labels: { [LABEL_P3_TAB]: tabId } });
    for (const terminal of listed?.terminals ?? []) await coreMux.closePane(_pi, String(terminal.address)).catch(() => undefined);
    for (const [token, slot] of slots) if (slot.tabId === tabId) slots.delete(token);
  },
  async createTab(_pi, options: CreateTabOptions) { return reserve(options.workspaceId || undefined, undefined, options.cwd, options.env, options.labels); },
  async startAgent(_pi, name, paneId, args) {
    const slot = slots.get(paneId);
    if (!slot) throw new Error(`Herdr Core has no pane ${paneId} to start an agent in; reserve a placement with createTab/worktreeOpen`);
    // Like a worker, a peer is a core terminal that outlives this session; only p3's own variables are passed
    // (never HERDR_*), plus the Pi config dir a core terminal would not otherwise inherit.
    const run = await call("terminal.run", {
      argv: [piExecutable(), ...args], cwd: slot.cwd, name,
      env: { ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}), ...slot.env },
      labels: { ...slot.labels, [LABEL_HANDLE]: name },
      // A peer (worktree placement) is independent, as under the TUI: no core parent, so the App lists it as its
      // own agent rather than under this session. Attachments stay this session's children.
      ...(slot.labels[LABEL_WORKTREE] ? { no_parent: true } : { caller: callerId() }),
      outlive_parent: true, no_notify: true,
    }, 30_000);
    slots.delete(paneId);
    return normalizeCoreTerminal(run);
  },
  async launchWorker(_pi, request: WorkerLaunchRequest, progress) {
    const env: Record<string, string> = {
      ...(request.manifestPath ? { PI_ROUTING_MANIFEST: request.manifestPath } : {}),
      ...(request.background ? { PI_SUBAGENT_MODE: "background" } : {}),
      ...(request.assignmentId ? { PI_ROUTED_ASSIGNMENT_ID: request.assignmentId } : {}),
      ...(request.readonly ? { PI_ROUTED_READONLY: "1" } : {}),
      // Unlike a TUI pane, a core terminal does not inherit this session's environment: keep a custom Pi config dir.
      ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
    };
    const labels: Record<string, string> = {
      [LABEL_HANDLE]: request.handle ?? request.name,
      ...(request.assignmentId ? { [LABEL_ASSIGNMENT]: request.assignmentId } : {}),
      ...(request.sessionPath ? { [LABEL_SESSION]: request.sessionPath } : {}),
    };
    progress.stage = "pane_allocation";
    // `env` is applied on top of the core's own environment (API keys, PATH), so only p3's variables are passed;
    // nothing from this process, and in particular no HERDR_*, reaches the worker.
    const run = await call("terminal.run", {
      argv: [piExecutable(), ...request.args], cwd: request.cwd, env, labels, name: request.name,
      caller: callerId(), outlive_parent: true, no_notify: true,
    }, 30_000);
    const address = String(run.address);
    const worker = { agent: address, paneId: address, terminalId: address };
    progress.worker = worker;
    progress.attempted = true;
    progress.started = true;
    progress.stage = "allocation_record";
    request.onAllocated?.(worker);
    progress.stage = "interactive_readiness";
    return worker;
  },
  async reportSession(_pi, terminalId, sessionPath) {
    if (publishedSession.get(terminalId) === sessionPath) return;
    await call("terminal.label", { terminal: terminalId, labels: { [LABEL_SESSION]: sessionPath } });
    publishedSession.set(terminalId, sessionPath);
  },
  async reportMetadata(_pi, terminalId, _source, tokens) {
    // A label with an empty value is removed.
    await call("terminal.label", { terminal: terminalId, labels: Object.fromEntries(Object.entries(tokens).map(([key, value]) => [`p3.${key}`, value ?? ""])) });
  },
  async worktreeList(pi, request): Promise<WorktreeSource> {
    const cwd = request.cwd ?? process.cwd();
    return { repoRoot: await repoRoot(pi, cwd) };
  },
  async worktreeOpen(pi, action, request: WorktreeRequest): Promise<WorktreePlacement> {
    const root = await repoRoot(pi, request.cwd ?? process.cwd());
    const entries = await worktreeEntries(pi, root);
    const wanted = request.path ? safeRealpath(request.path) : undefined;
    let entry = entries.find((candidate) => (wanted ? safeRealpath(candidate.path) === wanted : candidate.branch === request.branch));
    if (action === "create") {
      if (!request.branch) throw new Error("branch is required");
      if (entry) throw new Error(`Branch ${request.branch} is already checked out at ${entry.path}`);
      const path = request.path ?? defaultWorktreePath(root, request.branch);
      await git(pi, root, ["worktree", "add", "-b", request.branch, path]);
      entry = { path, branch: request.branch };
    } else if (!entry) {
      if (!request.branch || request.path) throw new Error(`No worktree ${request.path ?? request.branch} found in ${root}`);
      const path = defaultWorktreePath(root, request.branch);
      await git(pi, root, ["worktree", "add", path, request.branch]);
      entry = { path, branch: request.branch };
    }
    const worktreePath = realpathSync(entry.path);
    // A live terminal already serving this checkout means its space is open: the new agent joins it as a tab.
    const live = request.reuseSpace ? undefined : await liveSpaceFor(worktreePath);
    const workspaceId = request.reuseSpace ?? live ?? `p3-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const placed = reserve(workspaceId, undefined, worktreePath, undefined, { [LABEL_WORKTREE]: worktreePath, ...(entry.branch ? { [LABEL_BRANCH]: entry.branch } : {}) });
    return { workspaceId, rootPaneId: live ? "" : placed.paneId!, worktreePath, alreadyOpen: !!live };
  },
};
