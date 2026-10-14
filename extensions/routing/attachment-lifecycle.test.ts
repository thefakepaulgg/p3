import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import attachmentLifecycle, { attachmentSocketPath, readAttachmentPresence, writeAttachmentControlToken, writeAttachmentRecord, type AttachmentRecord } from "./attachment-lifecycle.ts";

const envNames = ["PI_CODING_AGENT_DIR", "PI_ROUTED_ATTACHMENT_ID", "PI_ROUTED_READONLY", "HERDR_PANE_ID"] as const;
let temp: string;
let previousEnv: Record<string, string | undefined>;
let handlers: Record<string, Function[]>;
let editor = "";
let idle = true;
let shutdowns = 0;
const pi: any = { on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler) };
const emit = async (event: string, payload: any, ctx: any) => { for (const handler of handlers[event] ?? []) await handler({ type: event, ...payload }, ctx); };

beforeEach(() => {
  previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  temp = realpathSync(mkdtempSync(join(tmpdir(), "p3-attach-life-")));
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.HERDR_PANE_ID = "w1:p7";
  delete process.env.PI_ROUTED_READONLY;
  handlers = {}; editor = ""; idle = true; shutdowns = 0;
});
afterEach(async () => {
  for (const handler of handlers.session_shutdown ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctxFor("/nonexistent", "x"));
  rmSync(temp, { recursive: true, force: true });
  for (const key of envNames) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
});

const ctxFor = (file: string, id: string): any => ({ hasUI: true, isIdle: () => idle, hasPendingMessages: () => false,
  ui: { getEditorText: () => editor, notify() {} }, sessionManager: { getSessionFile: () => file, getSessionId: () => id }, shutdown: () => { shutdowns++; } });

function setup() {
  const attachmentId = randomUUID();
  const sessionId = randomUUID();
  const sessionPath = join(temp, "s.jsonl");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd: temp })}\n`);
  const record: AttachmentRecord = { version: 1, attachmentId, parentSessionId: "parent", handle: "rt-a", sourceHandle: "rt-a", sessionPath, sessionId, cwd: temp,
    model: { provider: "p", modelId: "m" }, thinking: "high", label: "x", status: "starting", paneId: "w1:p7", terminalId: "term-a", openedAt: 1,
    usageStartOffset: 0, usageOffset: 0, estimatedCost: 0, costKnown: true, costComplete: true };
  writeAttachmentRecord(record);
  writeAttachmentControlToken(attachmentId, "secret");
  process.env.PI_ROUTED_ATTACHMENT_ID = attachmentId;
  attachmentLifecycle(pi);
  return { record, ctx: ctxFor(sessionPath, sessionId) };
}
const request = (record: AttachmentRecord, patch: object = {}) => new Promise<any>((resolve, reject) => {
  const socket = createConnection(attachmentSocketPath(record.attachmentId));
  let reply = "";
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write(`${JSON.stringify({ op: "status", token: "secret", attachmentId: record.attachmentId, parentSessionId: record.parentSessionId,
    paneId: record.paneId, terminalId: record.terminalId, sessionId: record.sessionId, ...patch })}\n`));
  socket.on("data", (chunk: string) => { reply += chunk; });
  socket.once("error", reject);
  socket.once("close", () => resolve(JSON.parse(reply)));
});

test("inactive without its attachment env and never loads worker assignment guards", () => {
  delete process.env.PI_ROUTED_ATTACHMENT_ID;
  attachmentLifecycle(pi);
  expect(handlers).toEqual({});
  setup();
  // Manual follow-ups are the human's: no input/agent/turn handlers that resolve or block turns.
  for (const event of ["input", "agent_start", "agent_settled", "turn_end", "tool_call"]) expect(handlers[event]).toBeUndefined();
});

test("publishes the exact PID at session_start before any model turn and serves verified control", async () => {
  const { record, ctx } = setup();
  await emit("session_start", { reason: "startup" }, ctx);
  expect(readAttachmentPresence(record.attachmentId)).toMatchObject({ pid: process.pid, sessionId: record.sessionId, sessionPath: record.sessionPath, paneId: "w1:p7" });
  expect(statSync(attachmentSocketPath(record.attachmentId)).mode & 0o777).toBe(0o600);
  expect(await request(record)).toMatchObject({ ok: true, pid: process.pid, idle: true });
  expect((await request(record, { token: "wrong" })).error).toContain("unverified");
  expect((await request(record, { terminalId: "other" })).error).toContain("unverified");
  editor = "draft";
  expect((await request(record, { op: "close" })).error).toContain("draft");
  editor = ""; idle = false;
  expect((await request(record, { op: "close" })).error).toContain("busy");
  idle = true;
  expect(shutdowns).toBe(0);
  expect(await request(record, { op: "close" })).toMatchObject({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(shutdowns).toBe(1);
  await emit("session_shutdown", { reason: "quit" }, ctx);
  expect(readAttachmentPresence(record.attachmentId)?.shutdown).toMatchObject({ reason: "quit", bytes: statSync(record.sessionPath).size });
  expect(existsSync(attachmentSocketPath(record.attachmentId))).toBe(false);
});

test("records /new or /resume drift and stops serving parent control, even after returning", async () => {
  const { record, ctx } = setup();
  await emit("session_start", { reason: "startup" }, ctx);
  await emit("session_shutdown", { reason: "new" }, ctx);
  const other = join(temp, "other.jsonl");
  writeFileSync(other, "{}\n");
  await emit("session_start", { reason: "new" }, ctxFor(other, "other-id"));
  expect(readAttachmentPresence(record.attachmentId)?.drift).toMatchObject({ reason: "new", sessionId: "other-id" });
  expect(existsSync(attachmentSocketPath(record.attachmentId))).toBe(false);
  await emit("session_start", { reason: "resume" }, ctx);
  expect(existsSync(attachmentSocketPath(record.attachmentId))).toBe(false);
});

test("refuses a mismatched pane", async () => {
  const { record, ctx } = setup();
  process.env.HERDR_PANE_ID = "w1:p8";
  await emit("session_start", { reason: "startup" }, ctx);
  expect(readAttachmentPresence(record.attachmentId)?.drift?.reason).toBe("startup");
  expect(existsSync(attachmentSocketPath(record.attachmentId))).toBe(false);
});

test("restores the original read-only policy", async () => {
  process.env.PI_ROUTED_READONLY = "1";
  const { ctx } = setup();
  await emit("session_start", { reason: "startup" }, ctx);
  const results = await Promise.all((handlers.tool_call ?? []).map((handler) => handler({ toolName: "bash" }, ctx)));
  expect(results.some((result: any) => result?.block === true)).toBe(true);
});
