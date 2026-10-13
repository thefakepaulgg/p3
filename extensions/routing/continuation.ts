import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAssignmentReceipt } from "./artifacts.ts";
import { readPendingAssignmentAsk } from "./questions.ts";
import { orchestrationError } from "./errors.ts";
import { parseJson, readHerdrSessionId, runHerdr } from "./herdr.ts";
import { isActiveTask, type TaskHandle } from "./state.ts";

export interface SavedRoutedSession { path: string; id: string; cwd: string; model: { provider: string; modelId: string }; thinking: TaskHandle["thinking"]; bytes: number }

export function savedRoutedSession(task: TaskHandle): SavedRoutedSession {
  if (!task.sessionPath || !task.sessionId || !task.cwd || !task.assignmentId || !task.parentSessionId || !task.capabilities) throw new Error("Saved routed identity/profile is incomplete; continuation cannot guess it");
  const path = realpathSync(task.sessionPath);
  if (!statSync(path).isFile()) throw new Error("Saved session is not a regular file");
  const session = SessionManager.open(path);
  const header = session.getHeader();
  const context = session.buildSessionContext();
  if (header?.id !== task.sessionId || !header.cwd || realpathSync(header.cwd) !== realpathSync(task.cwd)) throw new Error("Saved session identity or working directory conflicts with its owned task");
  if (!context.model?.provider || !context.model.modelId || !["off", "minimal", "low", "medium", "high"].includes(context.thinkingLevel)) throw new Error("Saved model/thinking is unavailable or outside p3's supported policy");
  return { path, id: header.id, cwd: header.cwd, model: context.model, thinking: context.thinkingLevel as TaskHandle["thinking"], bytes: statSync(path).size };
}

export async function validateContinuation(pi: ExtensionAPI, ctx: ExtensionContext, previous: TaskHandle, tasks: Iterable<TaskHandle>): Promise<SavedRoutedSession> {
  if (previous.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Continuation is limited to this parent's owned session history");
  if (previous.background || isActiveTask(previous) || previous.pendingCompletion || !previous.completionNotifiedAt && previous.state === "completed") throw new Error("The previous assignment is unresolved; finish delivery or explicitly stop it before continuation");
  if (previous.assignmentId && readPendingAssignmentAsk(previous.assignmentId)) throw new Error("Session has an outstanding question; reply or explicitly cancel it before continuation");
  const saved = savedRoutedSession(previous);
  const original = readAssignmentReceipt(previous.assignmentId!);
  if (!original || original.sessionId !== saved.id || original.paneId !== previous.paneId || original.terminalId !== previous.terminalId || !Number.isSafeInteger(original.workerPid) || original.workerPid! <= 0) throw new Error("Original Pi process identity is unverified; continuation cannot guess that it exited");
  try { process.kill(original.workerPid!, 0); throw new Error("Original Pi process has not exited; wait for cleanup before continuation"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  if ([...tasks].some((task) => task !== previous && task.sessionId === saved.id && isActiveTask(task))) throw new Error("The saved Pi session already has active or unresolved managed work");
  const model = ctx.modelRegistry.find(saved.model.provider, saved.model.modelId);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Saved model unavailable: ${saved.model.provider}/${saved.model.modelId}; no substitute was selected`);
  const agents = parseJson(await runHerdr(pi, ["agent", "list"], 5000), "continuation inventory")?.result?.agents;
  if (!Array.isArray(agents)) throw new Error("Current session inventory is unverified; do not start a second writer");
  for (const agent of agents) {
    if (agent.pane_id === previous.paneId || agent.terminal_id === previous.terminalId || readHerdrSessionId(agent.agent_session?.value) === saved.id || agent.agent_session?.value === saved.path) throw new Error("Saved session still has a live representation; close its retained pane before continuation");
    if (agent.agent === "pi" && agent.launch_pending) throw new Error("A pending Pi startup makes session absence ambiguous; inspect before continuation");
  }
  return saved;
}

/** Canonical-session exclusion spans primaries. Stale claims are reported, never stolen. */
export async function withSessionStartLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const root = join(getAgentDir(), "state", "routed-session-starts");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, `${createHash("sha256").update(realpathSync(path)).digest("hex")}.lock`);
  const owner = { pid: process.pid, generation: randomUUID(), sessionPath: realpathSync(path) };
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const held = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      try { process.kill(held.pid, 0); } catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    } catch { /* Unreadable claim remains unverified. */ }
    throw orchestrationError(new Error(`Saved-session startup lock exists at ${lock}`), "resume", { category: stale ? "stale_session_claim" : "session_busy", stage: "session_claim", retrySafe: false, nextAction: stale ? "Inspect the recorded dead process and current session inventory, then explicitly recover its private claim; no automatic theft or replay occurred." : "Wait for the current startup or inspect an unverifiable claim before retrying." });
  }
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600, flush: true });
    return await operation();
  } finally {
    const held = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    if (held.generation === owner.generation && held.pid === owner.pid) { unlinkSync(join(lock, "owner.json")); rmdirSync(lock); }
  }
}
