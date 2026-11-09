import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateContinuation, withSessionStartLock } from "./continuation.ts";
import { orchestrationError } from "./errors.ts";
import { buildRoutedWorkerPiArgs, readHerdrSessionId, verifyTaskAgent, waitForHerdrAgentReady } from "./herdr.ts";
import { mux, selfIdentity, type MuxAgent } from "./mux.ts";
import { isActiveTask, type TaskHandle } from "./state.ts";
import { readIncrementalUsage } from "./usage.ts";
import {
  assertSessionUnattached, attachmentSocketPath, claimSessionForAttachment, listParentAttachments, readAttachmentControlToken, readAttachmentPresence,
  readAttachmentRecord, releaseSessionClaim, sessionAttachment, writeAttachmentControlToken, writeAttachmentRecord, type AttachmentRecord,
} from "./attachment-store.ts";

export { assertSessionUnattached, listParentAttachments, readAttachmentRecord, type AttachmentRecord };

const LIFECYCLE = fileURLToPath(new URL("./attachment-lifecycle.ts", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pidState = (pid?: number): "alive" | "exited" | "unverified" => {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return "unverified";
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "unverified"; }
};

/** Cost from the actual append-only JSONL window this attachment owns. */
function measureUsage(record: AttachmentRecord, endOffset?: number): void {
  const usage = readIncrementalUsage(record.sessionPath, { sessionPath: record.sessionPath, offset: record.usageStartOffset, cost: 0, costKnown: false, complete: true },
    { startOffset: record.usageStartOffset, endOffset });
  Object.assign(record, { usageOffset: usage.offset, estimatedCost: usage.cost, costKnown: usage.costKnown, costComplete: usage.complete === true });
}

function requireOwned(ctx: ExtensionContext, id: string): AttachmentRecord {
  const record = readAttachmentRecord(id);
  if (!record) throw new Error(`Unknown attachment ${id}`);
  if (record.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Attachment belongs to another parent session; it is not controllable here");
  return record;
}

/** Exact pane → terminal → saved session chain for the recorded attachment. */
async function verifyLive(pi: ExtensionAPI, record: AttachmentRecord): Promise<void> {
  const agent = await mux().getAgent(pi, record.paneId!);
  const path = agent?.sessionPath;
  let canonical: string | undefined;
  try { canonical = path ? realpathSync(path) : undefined; } catch { /* unverified */ }
  if (agent?.paneId !== record.paneId || !record.terminalId || agent?.terminalId !== record.terminalId) throw new Error("Attachment terminal identity is unverified or replaced");
  if (canonical !== record.sessionPath || readHerdrSessionId(path) !== record.sessionId) throw new Error("Attachment Pi session identity is unverified or replaced");
  const presence = readAttachmentPresence(record.attachmentId);
  if (presence?.drift) throw new Error("Attachment session drift was recorded; parent control is refused");
  if (!presence || presence.pid !== record.workerPid || pidState(presence.pid) !== "alive") throw new Error("Attached Pi process identity is unverified");
}

async function proveAbsent(pi: ExtensionAPI, record: AttachmentRecord): Promise<boolean> {
  const agents = await mux().listAgents(pi);
  if (!agents) return false;
  return !agents.some((agent) => (record.paneId && agent.paneId === record.paneId) || (record.terminalId && agent.terminalId === record.terminalId) ||
    readHerdrSessionId(agent.sessionPath) === record.sessionId || agent.sessionPath === record.sessionPath);
}

/** Final window: the attached process's own shutdown size when it ended on the claimed session; otherwise partial. */
function finalize(record: AttachmentRecord, reason: string): AttachmentRecord {
  const presence = readAttachmentPresence(record.attachmentId);
  const size = statSync(record.sessionPath).size;
  const clean = presence?.pid === record.workerPid && !presence?.drift && presence?.shutdown && presence.shutdown.bytes >= record.usageStartOffset && presence.shutdown.bytes <= size;
  measureUsage(record, clean ? presence!.shutdown!.bytes : size);
  if (!clean) record.costComplete = false;
  Object.assign(record, { status: "closed", closedAt: Date.now() });
  record.error = presence?.drift ? `Session drift before close (${presence.drift.reason})` : undefined;
  if (!clean) record.error = [record.error, `Usage window is unverifiable/partial (${reason})`].filter(Boolean).join("; ");
  writeAttachmentRecord(record);
  releaseSessionClaim(record.attachmentId, record.sessionPath);
  return record;
}

function control(record: AttachmentRecord, op: "status" | "close"): Promise<any> {
  const token = readAttachmentControlToken(record.attachmentId);
  if (!token) return Promise.reject(new Error("Attachment control token is missing"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(attachmentSocketPath(record.attachmentId));
    let reply = "";
    const timer = setTimeout(() => socket.destroy(new Error("Attachment control acknowledgement timed out")), 5000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ op, token, attachmentId: record.attachmentId, parentSessionId: record.parentSessionId,
      paneId: record.paneId, terminalId: record.terminalId, sessionId: record.sessionId })}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; if (reply.length > 16384) socket.destroy(new Error("Invalid attachment control response")); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      try { const result = JSON.parse(reply); if (result.ok !== true) throw new Error(result.error ?? "Attachment state is unverified"); resolve(result); }
      catch (error) { reject(error); }
    });
  });
}

/**
 * Reconcile durable state with evidence. Finalizes only after the recorded PID is proven
 * exited and Herdr shows no representation; anything else keeps the claim held.
 */
export async function refreshAttachment(pi: ExtensionAPI, id: string): Promise<AttachmentRecord> {
  const record = readAttachmentRecord(id);
  if (!record) throw new Error(`Unknown attachment ${id}`);
  if (record.status === "closed" || record.status === "failed") return record;
  const pid = pidState(record.workerPid);
  if (pid === "exited" && await proveAbsent(pi, record).catch(() => false)) return finalize(record, "attached process exited outside parent close");
  measureUsage(record);
  if (record.status === "open" && pid !== "alive") { record.status = "unknown"; record.error = "Attached process identity is unverifiable; claim retained"; }
  const drift = readAttachmentPresence(id)?.drift;
  if (drift) record.error = `Attached pane left its session (${drift.reason}); parent control refused`;
  writeAttachmentRecord(record);
  return record;
}

export async function focusAttachment(pi: ExtensionAPI, ctx: ExtensionContext, id: string): Promise<{ record: AttachmentRecord; text: string }> {
  const record = await refreshAttachment(pi, requireOwned(ctx, id).attachmentId);
  if (record.status !== "open") throw new Error(`Attachment ${id} is ${record.status}; it cannot be focused`);
  await verifyLive(pi, record);
  const note = await mux().focusPane(pi, record.paneId!);
  return { record, text: note ?? `Focused attached session ${record.sessionId} (${record.sourceHandle}) in pane ${record.paneId}.${record.error ? ` ${record.error}` : ""}` };
}

/**
 * Human attachment of a finished owned worker's saved Pi session, or focus of an active
 * worker. Starts no prompt, model call or task replay, and never rewrites the source task.
 */
export async function openSavedAttachment(pi: ExtensionAPI, ctx: ExtensionContext, task: TaskHandle, tasks: Iterable<TaskHandle> = [task],
  manifestPath = task.workerManifestPath ?? process.env.PI_ROUTING_MANIFEST): Promise<{ record?: AttachmentRecord; text: string }> {
  const parentSessionId = ctx.sessionManager.getSessionId();
  if (task.parentSessionId !== parentSessionId) throw new Error("Attachment is limited to this parent's owned session history");
  // Any retained original pane is focused for inspection; a saved session is only activated once that executor is gone.
  if (task.paneId && !task.paneClosedAt) {
    let agent: MuxAgent | undefined;
    try { agent = await mux().getAgent(pi, task.agentName ?? task.paneId); }
    catch (error) { if (isActiveTask(task) || !/agent_not_found/.test(error instanceof Error ? error.message : String(error))) throw error; }
    if (agent) {
      verifyTaskAgent({ ...task }, agent); // copy: the source task is never rewritten
      const note = await mux().focusPane(pi, task.paneId);
      return { text: note ?? `Focused ${isActiveTask(task) ? "active" : "retained"} worker ${task.handle} in its original pane ${task.paneId}.` };
    }
  }
  if (isActiveTask(task)) throw new Error("Active worker pane is unavailable; inspect it before attaching its session");
  if (!task.sessionPath) throw new Error("Saved session path is unknown; attachment cannot guess it");
  const held = sessionAttachment(task.sessionPath);
  if (held) {
    if (held.claim.parentSessionId !== parentSessionId) throw orchestrationError(new Error("Saved session is attached by another parent"), "attach", { category: "session_attached", retrySafe: false, nextAction: "Close it from its owning parent." });
    return focusAttachment(pi, ctx, held.claim.attachmentId);
  }
  const initial = await validateContinuation(pi, ctx, task, tasks);
  return withSessionStartLock(initial.path, async () => {
    const saved = await validateContinuation(pi, ctx, task, tasks);
    assertSessionUnattached(saved.path);
    const { backend, rootWorkspaceId: workspaceId, rootTabId } = selfIdentity();
    if (!backend || !workspaceId || !rootTabId) throw new Error("Attachment requires a Herdr-managed parent with workspace and tab context");
    const record: AttachmentRecord = {
      version: 1, attachmentId: randomUUID(), parentSessionId, handle: task.handle, sourceHandle: task.handle, sourceAssignmentId: task.assignmentId,
      sessionPath: saved.path, sessionId: saved.id, cwd: saved.cwd, model: saved.model, thinking: saved.thinking, readonly: task.readonly,
      capabilities: task.capabilities, label: task.label, status: "starting", openedAt: Date.now(),
      usageStartOffset: saved.bytes, usageOffset: saved.bytes, estimatedCost: 0, costKnown: true, costComplete: true,
    };
    writeAttachmentRecord(record);
    writeAttachmentControlToken(record.attachmentId, randomUUID());
    try { claimSessionForAttachment(record); }
    catch (error) { writeAttachmentRecord({ ...record, status: "failed", error: String(error) }); throw error; }
    const fail = (status: "failed" | "unknown", error: unknown) => {
      Object.assign(record, { status, error: error instanceof Error ? error.message : String(error) });
      if (status === "failed") { record.closedAt = Date.now(); writeAttachmentRecord(record); releaseSessionClaim(record.attachmentId, record.sessionPath); }
      else writeAttachmentRecord(record);
    };

    let created: { paneId?: string; tabId?: string };
    try {
      created = await mux().createTab(pi, { workspaceId, cwd: saved.cwd, label: `Attached · ${task.label}`.slice(0, 80), focus: true, env: {
        PI_ROUTED_ROOT_WORKSPACE_ID: workspaceId, PI_ROUTED_ROOT_TAB_ID: rootTabId,
        ...(manifestPath ? { PI_ROUTING_MANIFEST: manifestPath } : {}),
        PI_ROUTED_ATTACHMENT_ID: record.attachmentId, ...(task.readonly ? { PI_ROUTED_READONLY: "1" } : {}),
      } });
    } catch (error) {
      fail("unknown", error);
      throw orchestrationError(error, "attach", { stage: "tab_create", retrySafe: "unknown", ids: { sessionId: saved.id }, nextAction: `Inspect attachment ${record.attachmentId}; its claim is retained until the tab outcome is known.` });
    }
    record.paneId = created.paneId;
    record.tabId = created.tabId;
    if (!record.paneId || !record.tabId) {
      fail("unknown", "Herdr tab creation returned no exact tab/root pane identity");
      throw orchestrationError(new Error("Herdr tab creation returned no exact tab/root pane identity"), "attach", { stage: "tab_create", retrySafe: "unknown", nextAction: "Inspect Herdr before retrying; no guessed tab was removed." });
    }
    const slug = task.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "session";
    record.agentName = `a-${slug}-${Date.now().toString(36).slice(-5)}`.slice(0, 32);
    writeAttachmentRecord(record);
    const args = [...buildRoutedWorkerPiArgs(task.label, { label: task.label, provider: saved.model.provider, model: saved.model.modelId, thinking: saved.thinking, purpose: "Human session attachment" },
      task.capabilities, task.readonly), "--session", saved.path, "--extension", LIFECYCLE];
    // --name appends session_info even when unchanged; browsing must not rewrite saved history.
    const nameIndex = args.indexOf("--name");
    if (nameIndex >= 0) args.splice(nameIndex, 2);
    try {
      let started = false;
      for (const delay of [150, 350, 750, 1500]) {
        await pause(delay);
        try {
          const agent = await mux().startAgent(pi, record.agentName, record.paneId, args);
          if (!(agent?.interactiveReady === true && agent.launchPending !== true)) await waitForHerdrAgentReady(pi, record.agentName);
          started = true;
          break;
        } catch (error) { if (!/agent_pane_busy/.test(error instanceof Error ? error.message : String(error))) throw error; }
      }
      if (!started) throw new Error("Attachment pane did not become available");
      const info = await mux().getAgent(pi, record.agentName);
      if (info?.paneId !== record.paneId || !info.terminalId) throw new Error("Attachment terminal identity is unverified");
      record.terminalId = info.terminalId;
      const presence = readAttachmentPresence(record.attachmentId);
      if (!presence || presence.drift || presence.sessionId !== saved.id || presence.sessionPath !== saved.path || presence.paneId !== record.paneId || pidState(presence.pid) !== "alive") throw new Error("Attached Pi process did not publish its exact session identity");
      record.workerPid = presence.pid;
      await verifyLive(pi, record);
      record.status = "open";
      writeAttachmentRecord(record);
    } catch (error) {
      // Roll back only when the exact fresh tab demonstrably holds no Pi process.
      let rolledBack = false;
      try {
        if (!readAttachmentPresence(record.attachmentId) && await proveAbsent(pi, record)) { await mux().closeTab(pi, record.tabId); rolledBack = true; }
      } catch { /* retained for inspection */ }
      fail(rolledBack ? "failed" : "unknown", error);
      throw orchestrationError(error, "attach", { stage: "agent_start", rollbackOccurred: rolledBack, retrySafe: rolledBack ? true : "unknown", ids: { sessionId: saved.id, paneId: record.paneId, tabId: record.tabId },
        nextAction: rolledBack ? "The fresh attachment tab was rolled back; resolve the startup failure before retrying." : `Inspect attachment ${record.attachmentId}; its claim is retained and nothing was replayed.` });
    }
    return { record, text: `Opened ${task.handle}'s saved Pi session ${saved.id} in dedicated tab ${record.tabId} (pane ${record.paneId}) with ${saved.model.provider}/${saved.model.modelId} (${saved.thinking}). No prompt was sent and the original task was not replayed; manual follow-ups are yours and do not change its completed result.` };
  });
}

/** Parent-initiated close: child proves idle, no queued input and an empty editor, then shuts itself down. */
export async function closeAttachment(pi: ExtensionAPI, ctx: ExtensionContext, id: string): Promise<{ record: AttachmentRecord; text: string }> {
  let record = await refreshAttachment(pi, requireOwned(ctx, id).attachmentId);
  if (record.status === "closed") return { record, text: `Attachment ${id} is already closed.` };
  if (record.status !== "open") throw new Error(`Attachment ${id} is ${record.status}; ${record.error ?? "inspect it before closing"}`);
  if (readAttachmentPresence(id)?.drift) throw new Error(`Attachment ${id} left its claimed session; parent control is refused. Close it from its own pane.`);
  await verifyLive(pi, record);
  await control(record, "close");
  const deadline = Date.now() + 15_000;
  while (pidState(record.workerPid) === "alive" && Date.now() < deadline) await pause(100);
  if (pidState(record.workerPid) !== "exited") throw new Error(`Attached Pi process ${record.workerPid} has not exited; the claim is retained`);
  try {
    const panes = await mux().listPanes(pi, selfIdentity().rootWorkspaceId ?? "");
    const tabPanes = panes ? panes.filter((pane) => pane.tabId === record.tabId) : [];
    if (tabPanes.length === 1 && tabPanes[0].paneId === record.paneId) await mux().closeTab(pi, record.tabId!);
    else if (tabPanes.some((pane) => pane.paneId === record.paneId)) await mux().closePane(pi, record.paneId!);
  } catch (error) {
    throw orchestrationError(error, "attach.close", { stage: "pane_cleanup", retrySafe: "unknown", ids: { attachmentId: id, paneId: record.paneId }, nextAction: "The Pi process exited; verify the exact leftover pane before retrying cleanup. Its claim remains held." });
  }
  record = finalize(readAttachmentRecord(id)!, "parent close");
  return { record, text: `Closed attached session ${record.sessionId}. Window usage ${record.costKnown ? `$${record.estimatedCost.toFixed(4)}` : "unknown"}${record.costComplete ? "" : " (partial)"}.` };
}
