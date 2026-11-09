import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tuiMux } from "./mux-tui.ts";

/** Terminal multiplexer behind this Pi session: Herdr TUI or Herdr Core / Herdr App. */
export type MuxBackend = "tui" | "core";

/** Backend-neutral agent record. `raw` is the backend's own payload for diagnostics only. */
export interface MuxAgent {
  id: string;
  name?: string;
  /** Backend agent kind, e.g. "pi". */
  kind?: string;
  paneId?: string;
  terminalId?: string;
  workspaceId?: string;
  status: string;
  /** Saved Pi session file reported by the backend. */
  sessionPath?: string;
  launchPending?: boolean;
  interactiveReady?: boolean;
  raw: any;
}

export interface MuxPane { paneId: string; tabId?: string }
export interface WorkerPane { paneId: string; tabId: string; createdTab: boolean }
export interface WorkerPaneOptions { manifestPath?: string; background?: boolean; assignmentId?: string; readonly?: boolean }
export interface CreateTabOptions { workspaceId: string; cwd: string; label: string; env?: Record<string, string>; focus: boolean }
export interface WorktreeSource { repoRoot: string; sourceWorkspaceId?: string }
export interface WorktreeRequest { workspaceId?: string; cwd?: string; branch?: string; path?: string; label?: string }
export interface WorktreePlacement { workspaceId: string; rootPaneId: string; worktreePath: string; alreadyOpen: boolean }

/**
 * Semantic multiplexer operations. Methods that return `undefined` for a list/record mean the
 * backend answered without it; callers treat that as unverified, never as absence.
 */
export interface Mux {
  readonly backend: MuxBackend;
  getAgent(pi: ExtensionAPI, target: string): Promise<MuxAgent | undefined>;
  listAgents(pi: ExtensionAPI): Promise<MuxAgent[] | undefined>;
  /** Start a Pi agent process in an existing pane; resolves once the backend acknowledges the launch. */
  startAgent(pi: ExtensionAPI, name: string, paneId: string, args: string[]): Promise<MuxAgent | undefined>;
  /** With `awaitStart`, also waits (bounded) for the agent to leave idle; may reject `agent_prompt_stalled`. */
  prompt(pi: ExtensionAPI, target: string, text: string, opts?: { awaitStart?: boolean }): Promise<void>;
  sendKeys(pi: ExtensionAPI, target: string, keys: string[]): Promise<void>;
  wait(pi: ExtensionAPI, target: string, until: string[], timeoutMs: number): Promise<void>;
  read(pi: ExtensionAPI, target: string, lines: number): Promise<string>;
  focusPane(pi: ExtensionAPI, paneId: string): Promise<void>;
  listPanes(pi: ExtensionAPI, workspaceId?: string): Promise<MuxPane[] | undefined>;
  closePane(pi: ExtensionAPI, paneId: string): Promise<void>;
  closeTab(pi: ExtensionAPI, tabId: string): Promise<void>;
  createTab(pi: ExtensionAPI, options: CreateTabOptions): Promise<{ paneId?: string; tabId?: string }>;
  /** Find or create a pane for a routed worker inside this session's isolated subagent tabs. */
  allocateWorkerPane(pi: ExtensionAPI, cwd: string, options?: WorkerPaneOptions): Promise<WorkerPane>;
  reportSession(pi: ExtensionAPI, paneId: string, sessionPath: string, sequence: number, startSource?: string): Promise<void>;
  /** String values set a token; null clears it. */
  reportMetadata(pi: ExtensionAPI, paneId: string, source: string, tokens: Record<string, string | null>): Promise<void>;
  worktreeList(pi: ExtensionAPI, request: { cwd?: string; workspaceId?: string }): Promise<WorktreeSource>;
  worktreeOpen(pi: ExtensionAPI, action: "create" | "open", request: WorktreeRequest): Promise<WorktreePlacement>;
}

export interface SelfIdentity {
  /** Detected backend; undefined outside a managed pane. */
  backend?: MuxBackend;
  /** Pane id for the TUI backend, terminal id for core. */
  id?: string;
  workspaceId?: string;
  tabId?: string;
  /** Workspace / tab of the primary that owns the routed tabs (PI_ROUTED_ROOT_* override, else own). */
  rootWorkspaceId?: string;
  rootTabId?: string;
  role?: string;
}

let override: Mux | undefined;
let memo: { key: string; backend: MuxBackend | undefined } | undefined;

/** Test seam: force a backend implementation (or restore detection with no argument). */
export function setMuxForTests(mux?: Mux): void {
  override = mux;
}

/**
 * Core wins when HC_TERMINAL_ID is set. Memoized on the three variables that decide it, so a
 * test or inherited environment that changes them is never served a stale answer.
 */
export function detectMux(env: NodeJS.ProcessEnv = process.env): MuxBackend | undefined {
  if (override && env === process.env) return override.backend;
  const key = `${env.HC_TERMINAL_ID ?? ""}\0${env.HERDR_ENV ?? ""}\0${env.HERDR_PANE_ID ?? ""}`;
  if (env === process.env && memo?.key === key) return memo.backend;
  const backend = env.HC_TERMINAL_ID ? "core" : env.HERDR_ENV === "1" && env.HERDR_PANE_ID ? "tui" : undefined;
  if (env === process.env) memo = { key, backend };
  return backend;
}

export function selfIdentity(env: NodeJS.ProcessEnv = process.env): SelfIdentity {
  const backend = detectMux(env);
  if (backend === "core") return { backend, id: env.HC_TERMINAL_ID, role: env.HERDR_ROLE };
  // Without a detected backend these stay raw HERDR_* reads: partial environments (a pane id
  // alone) have always identified the worker to its own guards.
  return {
    backend, id: env.HERDR_PANE_ID, workspaceId: env.HERDR_WORKSPACE_ID, tabId: env.HERDR_TAB_ID,
    rootWorkspaceId: env.PI_ROUTED_ROOT_WORKSPACE_ID ?? env.HERDR_WORKSPACE_ID, rootTabId: env.PI_ROUTED_ROOT_TAB_ID ?? env.HERDR_TAB_ID,
    role: env.HERDR_ROLE,
  };
}

const notImplemented = async (): Promise<never> => { throw new Error("Herdr Core backend is not implemented yet (Phase 2)"); };

const coreMux: Mux = {
  backend: "core",
  getAgent: notImplemented, listAgents: notImplemented, startAgent: notImplemented, prompt: notImplemented, sendKeys: notImplemented,
  wait: notImplemented, read: notImplemented, focusPane: notImplemented, listPanes: notImplemented, closePane: notImplemented,
  closeTab: notImplemented, createTab: notImplemented, allocateWorkerPane: notImplemented, reportSession: notImplemented,
  reportMetadata: notImplemented, worktreeList: notImplemented, worktreeOpen: notImplemented,
};

/** Operations always have an implementation; the Herdr TUI one serves unmanaged environments as before. */
export function mux(): Mux {
  return override ?? (detectMux() === "core" ? coreMux : tuiMux);
}
