import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askPathForAssignment, assignmentDirectory, writeAssignmentReceipt } from "./artifacts.ts";
import { readAssignmentAsk, readPendingAssignmentAsk, registerAssignmentQuestions, writeAssignmentReply, type AskIdentity } from "./questions.ts";

const names = ["PI_CODING_AGENT_DIR", "PI_ROUTED_ASSIGNMENT_ID", "HERDR_PANE_ID", "PI_ROUTING_MANIFEST"];
let saved: Record<string, string | undefined>;
let dir: string;
let assignmentId: string;
let identity: AskIdentity;
let tool: any;
let shutdown: Function;
let ctx: any;
let calls: any[];
let manifest: any;
beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  dir = mkdtempSync(join(tmpdir(), "routing-ask-"));
  assignmentId = randomUUID();
  identity = { requestId: randomUUID(), parentSessionId: "parent", sessionId: "worker", paneId: "w1:p2", terminalId: "terminal" };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_ROUTED_ASSIGNMENT_ID: assignmentId, HERDR_PANE_ID: identity.paneId, PI_ROUTING_MANIFEST: join(dir, "manifest.json") });
  writeAssignmentReceipt({ version: 1, assignmentId, ...identity, generation: 1, sessionPath: join(dir, "session"), outcome: "running", lastActivityAt: Date.now() });
  manifest = { version: "pi-routing/v1", parentPaneId: "w1:p1", parentSessionId: identity.parentSessionId, tasks: [{ assignmentId, ...identity }] };
  writeFileSync(process.env.PI_ROUTING_MANIFEST!, JSON.stringify(manifest));
  calls = [{ type: "toolCall", id: "call", name: "ask_parent", arguments: { question: "Choose?" } }];
  ctx = { cwd: dir, sessionManager: { getSessionId: () => identity.sessionId, getBranch: () => [{ type: "message", message: { role: "assistant", content: calls } }] } };
  registerAssignmentQuestions({ registerTool: (value: any) => { tool = value; }, on: (_name: string, handler: Function) => { shutdown = handler; } } as any, assignmentId);
});
afterEach(() => {
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  rmSync(dir, { recursive: true, force: true });
});
const execute = (signal?: AbortSignal, files?: string[]) => tool.execute("call", { question: "Choose?", files }, signal, undefined, ctx);

test("blocks until durable correlated reply, returns exact text and structured identity, then consumes", async () => {
  let finished = false;
  const pending = execute().then((result: any) => { finished = true; return result; });
  const ask = readPendingAssignmentAsk(assignmentId)!;
  expect(ask).toMatchObject({ ...identity, status: "waiting", question: "Choose?", version: 1 });
  await Promise.resolve();
  expect(finished).toBe(false);
  const text = "  exact\nreply\n";
  const reply = writeAssignmentReply(assignmentId, ask.id, text, identity);
  expect(readPendingAssignmentAsk(assignmentId)!.status).toBe("answered");
  const result = await pending;
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(result.details).toMatchObject({ assignmentId, askId: ask.id, ...identity, replyId: reply.replyId });
  expect(readAssignmentAsk(assignmentId)!.status).toBe("consumed");
  expect(readPendingAssignmentAsk(assignmentId)).toBeUndefined();
  expect(statSync(askPathForAssignment(assignmentId)).mode & 0o777).toBe(0o600);
  expect(() => writeAssignmentReply(assignmentId, ask.id, "again", identity)).toThrow();
});

test("rejects foreign, stale, duplicate replies and concurrent asks without overwriting", async () => {
  const controller = new AbortController();
  const pending = execute(controller.signal);
  const ask = readAssignmentAsk(assignmentId)!;
  for (const key of Object.keys(identity) as (keyof AskIdentity)[]) {
    expect(() => writeAssignmentReply(assignmentId, ask.id, "bad", { ...identity, [key]: "foreign" })).toThrow();
  }
  expect(() => writeAssignmentReply(assignmentId, randomUUID(), "stale", identity)).toThrow();
  await expect(execute()).rejects.toThrow("pending question");
  writeAssignmentReply(assignmentId, ask.id, "ok", identity);
  expect(() => writeAssignmentReply(assignmentId, ask.id, "duplicate", identity)).toThrow();
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(readAssignmentAsk(assignmentId)!.status).toBe("cancelled");
  expect(readPendingAssignmentAsk(assignmentId)).toBeUndefined();
});

test("sole saved assistant call and exact manifest owner are required before mutation", async () => {
  calls.push({ type: "toolCall", id: "other", name: "read" });
  await expect(execute()).rejects.toThrow("sole tool call");
  expect(existsSync(askPathForAssignment(assignmentId))).toBe(false);
  calls.pop(); calls[0].id = "foreign";
  await expect(execute()).rejects.toThrow();
  calls[0].id = "call";
  for (const key of ["requestId", "parentSessionId", "sessionId", "paneId", "terminalId"] as const) {
    const changed = { ...manifest, tasks: [{ ...manifest.tasks[0], [key]: "wrong" }] };
    writeFileSync(process.env.PI_ROUTING_MANIFEST!, JSON.stringify(changed));
    await expect(execute()).rejects.toThrow("owner");
    expect(existsSync(askPathForAssignment(assignmentId))).toBe(false);
  }
});

test("exclusive claim rejects a concurrent creator", async () => {
  const directory = assignmentDirectory(assignmentId);
  writeFileSync(join(directory, "ask.lock"), "", { flag: "wx" });
  await expect(execute()).rejects.toThrow();
  expect(existsSync(askPathForAssignment(assignmentId))).toBe(false);
});

test("snapshots evidence and shutdown durably cancels the wait", async () => {
  const file = join(dir, "evidence.txt");
  writeFileSync(file, "original");
  const pending = execute(undefined, [file]);
  writeFileSync(file, "changed");
  expect(readAssignmentAsk(assignmentId)!.evidence).toContain("original");
  expect(readFileSync(askPathForAssignment(assignmentId), "utf8")).not.toContain("changed");
  shutdown();
  await expect(pending).rejects.toThrow("cancelled");
  expect(readPendingAssignmentAsk(assignmentId)).toBeUndefined();
  expect(readAssignmentAsk(assignmentId)!.status).toBe("cancelled");
});

test("preaborted signal leaves no phantom question", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(execute(controller.signal)).rejects.toThrow("cancelled");
  expect(readAssignmentAsk(assignmentId)).toBeUndefined();
});
