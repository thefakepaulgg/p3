import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assignmentDirectory, atomicWriteArtifact, pathForResultRef, readAssignmentReceipt, askPathForAssignment } from "./artifacts.ts";
import { prepareEvidence } from "./evidence.ts";
import { readRoutingManifest } from "./manifest.ts";

export interface AskIdentity {
  requestId: string;
  parentSessionId: string;
  sessionId: string;
  paneId: string;
  terminalId: string;
}
export interface AssignmentAsk extends AskIdentity {
  version: 1;
  id: string;
  assignmentId: string;
  question: string;
  evidence?: string;
  status: "waiting" | "answered" | "consumed" | "cancelled";
  createdAt: number;
  reply?: string;
  replyId?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identityKeys = ["requestId", "parentSessionId", "sessionId", "paneId", "terminalId"] as const;

export function readAssignmentAsk(assignmentId: string): AssignmentAsk | undefined {
  try {
    const ask = JSON.parse(readFileSync(askPathForAssignment(assignmentId), "utf8")) as AssignmentAsk;
    if (ask.version !== 1 || ask.assignmentId !== assignmentId || !uuid.test(ask.id) || !uuid.test(ask.requestId) ||
      identityKeys.some((key) => typeof ask[key] !== "string" || !ask[key]) ||
      typeof ask.question !== "string" || !ask.question.trim() || ask.question.length > 4000 || !Number.isFinite(ask.createdAt) ||
      !["waiting", "answered", "consumed", "cancelled"].includes(ask.status) ||
      (ask.evidence !== undefined && typeof ask.evidence !== "string") ||
      (["answered", "consumed"].includes(ask.status) && (typeof ask.reply !== "string" || !ask.replyId || !uuid.test(ask.replyId)))) {
      throw new Error("Invalid routed question evidence");
    }
    return ask;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function readPendingAssignmentAsk(assignmentId: string): AssignmentAsk | undefined {
  const ask = readAssignmentAsk(assignmentId);
  return ask?.status === "waiting" || ask?.status === "answered" ? ask : undefined;
}

// All transitions share an exclusive claim: concurrent writers fail rather than overwrite replies.
function withClaim<T>(assignmentId: string, change: () => T): T {
  const directory = assignmentDirectory(assignmentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "ask.lock");
  const fd = openSync(lock, "wx", 0o600);
  try { return change(); } finally { closeSync(fd); unlinkSync(lock); }
}
const persist = (ask: AssignmentAsk) => { atomicWriteArtifact(askPathForAssignment(ask.assignmentId), JSON.stringify(ask)); return ask; };

export function writeAssignmentReply(assignmentId: string, askId: string, reply: string, identity: AskIdentity): AssignmentAsk {
  return withClaim(assignmentId, () => {
    const ask = readAssignmentAsk(assignmentId);
    const receipt = readAssignmentReceipt(assignmentId);
    if (!ask || ask.id !== askId || ask.status !== "waiting" || typeof reply !== "string" ||
      identityKeys.some((key) => ask[key] !== identity[key]) || !receipt ||
      receipt.outcome !== "running" || ["requestId", "sessionId", "paneId", "terminalId"].some((key) => receipt[key as keyof typeof receipt] !== ask[key as keyof AskIdentity])) {
      throw new Error("Reply is stale, foreign, or question is no longer waiting");
    }
    return persist({ ...ask, status: "answered", reply, replyId: randomUUID() });
  });
}

export function cancelAssignmentAsk(assignmentId: string): void {
  withClaim(assignmentId, () => {
    const ask = readPendingAssignmentAsk(assignmentId);
    if (ask) persist({ ...ask, status: "cancelled" });
  });
}

function owner(assignmentId: string, ctx: ExtensionContext): AskIdentity {
  const receipt = readAssignmentReceipt(assignmentId);
  const manifest = readRoutingManifest(process.env.PI_ROUTING_MANIFEST);
  const tasks = manifest?.tasks.filter((task) => task.assignmentId === assignmentId);
  const task = tasks?.length === 1 ? tasks[0] : undefined;
  if (process.env.PI_ROUTED_ASSIGNMENT_ID !== assignmentId || !receipt || receipt.outcome !== "running" ||
    receipt.sessionId !== ctx.sessionManager.getSessionId() || receipt.paneId !== process.env.HERDR_PANE_ID || !task ||
    task.sessionId !== receipt.sessionId || task.paneId !== receipt.paneId || task.terminalId !== receipt.terminalId ||
    task.requestId !== receipt.requestId || !task.parentSessionId || task.parentSessionId !== manifest?.parentSessionId) {
    throw new Error("Question owner does not match the current routed manifest and receipt");
  }
  return { requestId: receipt.requestId, parentSessionId: task.parentSessionId, sessionId: receipt.sessionId, paneId: receipt.paneId, terminalId: receipt.terminalId };
}

function assertSoleCall(toolCallId: string, ctx: ExtensionContext): void {
  const latest = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").at(-1);
  if (latest?.type !== "message" || latest.message.role !== "assistant") throw new Error("ask_parent requires a saved assistant tool call");
  const calls = latest.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0].id !== toolCallId || calls[0].name !== "ask_parent") {
    throw new Error("ask_parent must be the sole tool call in the assistant batch");
  }
}

function waitForReply(ask: AssignmentAsk, signal: AbortSignal | undefined): Promise<AssignmentAsk> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let scan: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: unknown, value?: AssignmentAsk) => {
      if (settled) return;
      settled = true; watcher?.close(); if (scan) clearInterval(scan); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => { try { cancelAssignmentAsk(ask.assignmentId); finish(new Error("ask_parent cancelled")); } catch (error) { finish(error); } };
    const check = () => {
      if (signal?.aborted) { abort(); return; }
      try {
        const current = readAssignmentAsk(ask.assignmentId);
        if (!current || current.id !== ask.id || current.status === "cancelled") throw new Error("ask_parent cancelled or replaced");
        if (current.status === "answered") finish(undefined, current);
      } catch (error) { finish(error); }
    };
    try { watcher = watch(assignmentDirectory(ask.assignmentId), check); watcher.on("error", () => { watcher?.close(); }); } catch { /* bounded scan remains active */ }
    scan = setInterval(check, 250);
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

export function registerAssignmentQuestions(pi: ExtensionAPI, assignmentId: string): void {
  pi.registerTool({
    name: "ask_parent", label: "Ask parent", description: "Ask the parent a blocking question. Must be the sole tool call in this assistant batch; waits for the exact durable reply.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), files: Type.Optional(Type.Array(Type.String())) }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      assertSoleCall(toolCallId, ctx);
      const identity = owner(assignmentId, ctx);
      if (!params.question.trim() || params.question.length > 4000) throw new Error("Question must be nonempty and at most 4000 characters");
      if (signal?.aborted) throw new Error("ask_parent cancelled before creation");
      const evidence = prepareEvidence(params.files, ctx.cwd, pathForResultRef).text;
      const ask = withClaim(assignmentId, () => {
        if (readPendingAssignmentAsk(assignmentId)) throw new Error("Assignment already has a pending question");
        return persist({ version: 1, id: randomUUID(), assignmentId, ...identity, question: params.question, ...(evidence ? { evidence } : {}), status: "waiting", createdAt: Date.now() });
      });
      const answered = await waitForReply(ask, signal);
      const consumed = withClaim(assignmentId, () => {
        const current = readAssignmentAsk(assignmentId);
        if (signal?.aborted) { if (current?.id === ask.id) persist({ ...current, status: "cancelled" }); throw new Error("ask_parent cancelled"); }
        if (current?.id !== ask.id || current.status !== "answered" || current.replyId !== answered.replyId) throw new Error("Question reply changed before consumption");
        return persist({ ...current, status: "consumed" });
      });
      return { content: [{ type: "text", text: consumed.reply! }], details: { assignmentId, askId: ask.id, ...identity, replyId: consumed.replyId } };
    },
  });
  pi.on("session_shutdown", () => { cancelAssignmentAsk(assignmentId); });
}
