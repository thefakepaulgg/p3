import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreMux } from "./mux-core.ts";
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
  /** TUI workspace id; on core the `herdr.space` label (a space the Herdr App shows), when the terminal has one. */
  workspaceId?: string;
  /** Core only: the `herdr.tab` label. */
  tabId?: string;
  status: string;
  /** Saved Pi session file reported by the backend. */
  sessionPath?: string;
  launchPending?: boolean;
  interactiveReady?: boolean;
  raw: any;
}

export interface MuxPane { paneId: string; tabId?: string }
export interface WorkerPaneOptions { manifestPath?: string; background?: boolean; assignmentId?: string; readonly?: boolean }
/** Where a launched worker lives. Core has no panes or tabs: `paneId` is then the terminal address and `tabId` is absent. */
export interface WorkerIdentity { agent: string; paneId: string; tabId?: string; terminalId?: string }
export interface WorkerLaunchRequest extends WorkerPaneOptions {
  /** Suggested agent name; the backend may return a different `agent` target id (core: the terminal address). */
  name: string;
  cwd: string;
  /** Pi arguments, without the `pi` executable. */
  args: string[];
  /** Subagent handle and (continuations) saved session path, recorded as backend labels where supported. */
  handle?: string;
  sessionPath?: string;
  /** Called as soon as the worker has an identity, before it is started or ready. */
  onAllocated?: (worker: WorkerIdentity) => void;
}
/** Mutated by launchWorker so a failing launch can be classified (rolled back vs ambiguous) by the caller. */
export interface WorkerLaunchProgress { stage: string; attempted: boolean; started: boolean; retryAttempted: boolean; worker?: WorkerIdentity }
/**
 * Core has no panes to pre-create: `createTab` then returns a reserved placement (`paneId` is a
 * `slot:` token, see isReservedPane) that `startAgent` consumes and that is replaced by the started
 * terminal's real address. Callers read the pane/terminal identity from the agent `startAgent` returns.
 * `workspaceId: ""` means "no placement": the core terminal is listed in the sidebar only.
 */
export interface CreateTabOptions { workspaceId: string; cwd: string; label: string; env?: Record<string, string>; focus: boolean; /** Core only: extra terminal labels. */ labels?: Record<string, string> }
export interface WorktreeSource { repoRoot: string; sourceWorkspaceId?: string }
/** `reuseSpace` (core only): place the agent in this recorded space instead of a new one. */
export interface WorktreeRequest { workspaceId?: string; cwd?: string; branch?: string; path?: string; label?: string; reuseSpace?: string }
export interface WorktreePlacement { workspaceId: string; rootPaneId: string; worktreePath: string; alreadyOpen: boolean }

/**
 * Semantic multiplexer operations. Methods that return `undefined` for a list/record mean the
 * backend answered without it; callers treat that as unverified, never as absence.
 */
export interface Mux {
  readonly backend: MuxBackend;
  getAgent(pi: ExtensionAPI, target: string): Promise<MuxAgent | undefined>;
  listAgents(pi: ExtensionAPI): Promise<MuxAgent[] | undefined>;
  /** Start a Pi agent process in an existing pane (core: a reserved placement); resolves once the backend acknowledges the launch. Peer/attachment paths only. */
  startAgent(pi: ExtensionAPI, name: string, paneId: string, args: string[]): Promise<MuxAgent | undefined>;
  /** With `awaitStart`, also waits (bounded) for the agent to leave idle; may reject `agent_prompt_stalled`. */
  prompt(pi: ExtensionAPI, target: string, text: string, opts?: { awaitStart?: boolean }): Promise<void>;
  sendKeys(pi: ExtensionAPI, target: string, keys: string[]): Promise<void>;
  wait(pi: ExtensionAPI, target: string, until: string[], timeoutMs: number): Promise<void>;
  read(pi: ExtensionAPI, target: string, lines: number): Promise<string>;
  /** Resolves a user-facing note when the backend cannot focus (core). */
  focusPane(pi: ExtensionAPI, paneId: string): Promise<string | undefined>;
  listPanes(pi: ExtensionAPI, workspaceId?: string): Promise<MuxPane[] | undefined>;
  closePane(pi: ExtensionAPI, paneId: string): Promise<void>;
  closeTab(pi: ExtensionAPI, tabId: string): Promise<void>;
  createTab(pi: ExtensionAPI, options: CreateTabOptions): Promise<{ paneId?: string; tabId?: string }>;
  /**
   * Allocate and start a routed Pi worker. Resolves once the process is started (the TUI also returns the
   * backend's start record); readiness is observed afterwards through getAgent.
   */
  launchWorker(pi: ExtensionAPI, request: WorkerLaunchRequest, progress: WorkerLaunchProgress): Promise<WorkerIdentity & { started?: MuxAgent }>;
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

/** Core placement token returned by createTab/worktreeOpen before the agent has a terminal address. */
export const isReservedPane = (id?: string): boolean => !!id?.startsWith("slot:");

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

/** Operations always have an implementation; the Herdr TUI one serves unmanaged environments as before. */
export function mux(): Mux {
  return override ?? (detectMux() === "core" ? coreMux : tuiMux);
}

/**
 * selfIdentity with the placement core keeps in terminal labels (`herdr.space` / `herdr.tab`): an
 * App-placed primary carries them, a bare core terminal does not (then both stay undefined).
 */
export async function selfPlacement(pi: ExtensionAPI): Promise<SelfIdentity> {
  const self = selfIdentity();
  if (self.backend !== "core" || !self.id) return self;
  const agent = await mux().getAgent(pi, self.id).catch(() => undefined);
  return {
    ...self, workspaceId: agent?.workspaceId, tabId: agent?.tabId,
    rootWorkspaceId: process.env.PI_ROUTED_ROOT_WORKSPACE_ID ?? agent?.workspaceId, rootTabId: process.env.PI_ROUTED_ROOT_TAB_ID ?? agent?.tabId,
  };
}
