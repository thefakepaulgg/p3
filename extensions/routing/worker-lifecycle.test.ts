import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerLifecycle from "./worker-lifecycle.ts";
import { writeCancellationIntent, assignmentDirectory, askPathForAssignment, atomicWriteArtifact, hashText, readAssignmentReceipt, readAssignmentResult, resultPathForAssignment } from "./artifacts.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";

const names = ["PI_CODING_AGENT_DIR", "PI_ROUTED_ASSIGNMENT_ID", "PI_ROUTED_READONLY", "PI_SUBAGENT_MODE", "HERDR_PANE_ID"] as const;
let previous: Record<string, string | undefined>;
let dir: string;
let assignmentId: string;
beforeEach(() => {
  previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  dir = mkdtempSync(join(tmpdir(), "routing-worker-"));
  assignmentId = randomUUID();
  Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_ROUTED_ASSIGNMENT_ID: assignmentId, HERDR_PANE_ID: "w1:p2" });
  delete process.env.PI_SUBAGENT_MODE;
  delete process.env.PI_ROUTED_READONLY;
});
afterEach(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
  rmSync(dir, { recursive: true, force: true });
});
setHerdrTestTransportForTests(async (pi: any, args, timeout) => {
  const result = await pi.exec("herdr", args, { timeout });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
});

const fixture = async () => {
  writeFileSync(join(dir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: assignmentId, timestamp: new Date().toISOString(), cwd: "/repo" })}\n`);
  const handlers = new Map<string, Function>();
  const entries: any[] = [];
  const pi: any = {
    registerTool: () => {},
    on: (name: string, handler: Function) => {
      const previous = handlers.get(name);
      handlers.set(name, previous ? (...args: any[]) => { const before = previous(...args); const after = handler(...args); return after ?? before; } : handler);
    },
    exec: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p2", terminal_id: "terminal-2" } } }) }),
    getAllTools: () => ["read", "ls", "find", "grep", "message_parent", "ask_parent", "bash", "write", "codemode", "workspace_agent"].map((name) => ({ name })),
    setActiveTools: (tools: string[]) => { pi.activeTools = tools; },
  };
  const ctx: any = { sessionManager: {
    getSessionId: () => assignmentId, getSessionFile: () => join(dir, "session.jsonl"), getEntries: () => entries,
  } };
  workerLifecycle(pi);
  await handlers.get("agent_start")!({}, ctx);
  return { handlers, entries, pi, ctx };
};

const response = (text = "Verified result", stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

test("native completed observations persist nonempty matching hash artifacts only at agent_settled", async () => {
  const { handlers, entries, ctx } = await fixture();
  writeCancellationIntent(readAssignmentReceipt(assignmentId)!);
  const message = response();
  entries.push({ type: "message", id: "response", message });
  handlers.get("turn_end")!({ outcome: "completed", message, messageEntryId: "response" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "completed" }, ctx);
  expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("running");
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
  handlers.get("agent_settled")!({}, ctx);
  const receipt = readAssignmentReceipt(assignmentId)!;
  expect(receipt).toMatchObject({ assignmentId, requestId: assignmentId, sessionId: assignmentId, paneId: "w1:p2", terminalId: "terminal-2", outcome: "completed", responseEntryId: "response", resultHash: hashText("Verified result") });
  expect(readAssignmentResult(assignmentId, receipt.resultHash!)).toBe("Verified result");
  expect(JSON.parse(readFileSync(join(assignmentDirectory(assignmentId), "metadata.json"), "utf8"))).toMatchObject({ generation: 1, sessionId: assignmentId, responseEntryId: "response", hash: receipt.resultHash });
});

test("native nonabort error never turns partial assistant text into a successful result", async () => {
  const { handlers, entries, ctx } = await fixture();
  const message = response("partial", "error");
  entries.push({ type: "message", id: "partial", message });
  handlers.get("turn_end")!({ outcome: "error", message, messageEntryId: "partial" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "error" }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("error");
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
});

for (const missing of ["entry", "text", "settled"] as const) {
  test(`omitted ${missing} evidence cannot complete`, async () => {
    const { handlers, entries, ctx } = await fixture();
    const message = response(missing === "text" ? "   " : "result");
    if (missing !== "entry") entries.push({ type: "message", id: "response", message });
    handlers.get("turn_end")!({ outcome: "completed", message, messageEntryId: "response" }, ctx);
    handlers.get("agent_before_settle")!({ outcome: "completed" }, ctx);
    if (missing !== "settled") handlers.get("agent_settled")!({}, ctx);
    expect(readAssignmentReceipt(assignmentId)!.outcome).toBe(missing === "settled" ? "running" : "error");
    expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
  });
}

test("a continued request uses its explicit UUID while keeping the original assignment receipt", async () => {
  const { handlers, entries, ctx } = await fixture();
  const requestId = randomUUID();
  handlers.get("message_start")!({ message: { role: "user", content: `p3:routed-request ${requestId}\nContinue` } }, ctx);
  const message = response();
  entries.push({ type: "message", id: "response", message });
  handlers.get("turn_end")!({ outcome: "completed", message, messageEntryId: "response" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "completed" }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  expect(readAssignmentReceipt(assignmentId)!.requestId).toBe(requestId);
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
  expect(readAssignmentResult(requestId, hashText("Verified result"))).toBe("Verified result");
});

test("readonly workers project the native allowlist and guard extension tool calls", async () => {
  process.env.PI_ROUTED_READONLY = "1";
  const { handlers, pi, ctx } = await fixture();
  handlers.get("session_start")!({}, ctx);
  expect(pi.activeTools).toEqual(["read", "ls", "find", "grep", "message_parent", "ask_parent"]);
  expect(await handlers.get("tool_call")!({ toolName: "read" }, ctx)).toBeUndefined();
  for (const toolName of ["bash", "write", "codemode", "workspace_agent"]) {
    expect(await handlers.get("tool_call")!({ toolName }, ctx)).toMatchObject({ block: true });
  }
});

for (const status of ["waiting", "answered"] as const) {
  test(`pending ${status} question prevents completed settlement at a strange boundary`, async () => {
    const { handlers, entries, ctx } = await fixture();
    const ask = { version: 1, id: randomUUID(), assignmentId, requestId: assignmentId, parentSessionId: "parent", sessionId: assignmentId, paneId: "w1:p2", terminalId: "terminal-2", question: "Choose?", status, createdAt: Date.now(), ...(status === "answered" ? { reply: "yes", replyId: randomUUID() } : {}) };
    atomicWriteArtifact(askPathForAssignment(assignmentId), JSON.stringify(ask));
    const message = response();
    entries.push({ type: "message", id: "response", message });
    handlers.get("turn_end")!({ outcome: "completed", message, messageEntryId: "response" }, ctx);
    handlers.get("agent_before_settle")!({ outcome: "completed" }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("running");
    expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
    handlers.get("agent_before_settle")!({ outcome: "aborted" }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("aborted");
    expect(JSON.parse(readFileSync(askPathForAssignment(assignmentId), "utf8")).status).toBe("cancelled");
  });
}

test("finished inspection worker preserves a new human draft and never overwrites its result", async () => {
  const { handlers, entries, ctx } = await fixture();
  const message = response("Original immutable output");
  entries.push({ type: "message", id: "response", message });
  handlers.get("turn_end")!({ message, messageEntryId: "response" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "completed" }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  const original = readAssignmentReceipt(assignmentId)!;
  let draft = "";
  ctx.ui = { setEditorText: (text: string) => { draft = text; }, notify: () => {} };
  expect(handlers.get("input")!({ source: "interactive", text: "Unsubmitted follow-up" }, ctx)).toEqual({ action: "handled" });
  expect(draft).toBe("Unsubmitted follow-up");
  await handlers.get("agent_start")!({}, ctx);
  expect(await handlers.get("tool_call")!({ toolName: "write" }, ctx)).toMatchObject({ block: true, terminate: true });
  const unwanted = response("Must not replace the original output");
  entries.push({ type: "message", id: "unowned-response", message: unwanted });
  handlers.get("turn_end")!({ message: unwanted, messageEntryId: "unowned-response" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "completed" }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  expect(readAssignmentReceipt(assignmentId)).toEqual(original);
  expect(readAssignmentResult(assignmentId, original.resultHash!)).toBe("Original immutable output");
});

for (const scenario of [
  { name: "correlated native tool abort", errorMessage: "This operation was aborted", intent: true, expected: "aborted" },
  { name: "uncorrelated abort sentinel", errorMessage: "This operation was aborted", intent: false, expected: "error" },
  { name: "ordinary error after Esc", errorMessage: "Controlled provider failure", intent: true, expected: "error" },
  { name: "abort-looking provider text", errorMessage: "Request aborted by upstream policy", intent: true, expected: "error" },
]) {
  test(`${scenario.name} uses persisted native evidence, never partial output`, async () => {
    const { handlers, entries, ctx } = await fixture();
    if (scenario.intent) writeCancellationIntent(readAssignmentReceipt(assignmentId)!);
    const message = { ...response("Partial text is not a result", "error"), errorMessage: scenario.errorMessage };
    entries.push({ type: "message", id: "abort-entry", message });
    handlers.get("turn_end")!({ outcome: "error", message, messageEntryId: "abort-entry" }, ctx);
    handlers.get("agent_before_settle")!({ outcome: "error" }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    expect(readAssignmentReceipt(assignmentId)!.outcome).toBe(scenario.expected);
    expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
  });
}

test("a cancellation intent never leaks into the next native generation", async () => {
  const { handlers, entries, ctx } = await fixture();
  writeCancellationIntent(readAssignmentReceipt(assignmentId)!);
  const abort = { ...response("", "error"), errorMessage: "This operation was aborted" };
  entries.push({ type: "message", id: "first-abort", message: abort });
  handlers.get("turn_end")!({ outcome: "error", message: abort, messageEntryId: "first-abort" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "error" }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("aborted");
  await handlers.get("agent_start")!({}, ctx);
  entries.push({ type: "message", id: "second-error", message: abort });
  handlers.get("turn_end")!({ outcome: "error", message: abort, messageEntryId: "second-error" }, ctx);
  handlers.get("agent_before_settle")!({ outcome: "error" }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  expect(readAssignmentReceipt(assignmentId)!.generation).toBe(2);
  expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("error");
});
