import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CoreRpcError, requestCore } from "./core-socket.ts";
import type { Mux, MuxAgent, MuxPane, WorkerLaunchRequest } from "./mux.ts";

// Herdr Core backend. A worker is a core terminal: the agent id, "pane id" and terminal id are all
// the terminal address (`t7`, stable for the life of the core). Status comes from the program's own
// OSC 7501 reports; identity that core cannot know (the Pi session file) is published as labels.

export const LABEL_HANDLE = "p3.handle";
export const LABEL_SESSION = "p3.session";
export const LABEL_ASSIGNMENT = "p3.assignment";

const unsupported = (what: string) => async (): Promise<never> => { throw new Error(`${what} is not supported on Herdr Core yet`); };

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
    status: String(raw.status?.state ?? (raw.state === "finished" ? "exited" : "unknown")),
    sessionPath: labels[LABEL_SESSION], launchPending: isPi ? !ready : undefined, interactiveReady: isPi ? ready : undefined, raw,
  };
};

const getTerminal = async (target: string): Promise<any> => {
  const terminal = await call("terminal.get", { terminal: target });
  if (terminal.state === "finished") throw new Error(`agent_not_found: terminal ${terminal.address} has finished (${terminal.reason ?? "exited"}, exit code ${terminal.exit_code ?? "n/a"})`);
  return terminal;
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
  async focusPane(_pi, paneId) { return `Herdr Core has no panes to focus; ${paneId} is listed in the Herdr App sidebar under its parent.`; },
  async listPanes() {
    const listed = await call("terminal.list", {});
    return Array.isArray(listed?.terminals) ? listed.terminals.map((terminal: any): MuxPane => ({ paneId: String(terminal.address) })) : undefined;
  },
  // A worker "pane" is its terminal: closing it ends the program and removes the record.
  async closePane(_pi, paneId) {
    await call("terminal.kill", { terminal: paneId }, 15_000);
    await call("terminal.rm", { terminal: paneId });
  },
  closeTab: unsupported("Closing tabs"),
  createTab: unsupported("Creating tabs"),
  startAgent: unsupported("Starting an agent in an existing pane"),
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
      argv: ["pi", ...request.args], cwd: request.cwd, env, labels, name: request.name,
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
  worktreeList: unsupported("Worktree listing"),
  worktreeOpen: unsupported("Worktree creation"),
};
