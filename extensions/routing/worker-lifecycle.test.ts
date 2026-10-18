import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerLifecycle from "./worker-lifecycle.ts";
import bashBackground, { BASH_PENDING_EVENT, BASH_STOP_EVENT } from "../bash-background.ts";
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

const fixture = async (options: { bash?: boolean; ui?: any } = {}) => {
  writeFileSync(join(dir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: assignmentId, timestamp: new Date().toISOString(), cwd: "/repo" })}\n`);
  const handlers = new Map<string, Function>();
  const entries: any[] = [];
  // Pi's EventBus is a synchronous EventEmitter shared by every extension in the process.
  const bus = new EventEmitter();
  const events = { on: (channel: string, handler: (data: unknown) => void) => { bus.on(channel, handler); return () => bus.off(channel, handler); }, emit: (channel: string, data: unknown) => bus.emit(channel, data) };
  const pi: any = {
    registerTool: () => {},
    on: (name: string, handler: Function) => {
      const previous = handlers.get(name);
      handlers.set(name, previous ? (...args: any[]) => { const before = previous(...args); const after = handler(...args); return after ?? before; } : handler);
    },
    events,
    exec: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p2", terminal_id: "terminal-2" } } }) }),
    getAllTools: () => ["read", "ls", "find", "grep", "message_parent", "ask_parent", "bash", "write", "codemode", "workspace_agent"].map((name) => ({ name })),
    setActiveTools: (tools: string[]) => { pi.activeTools = tools; },
  };
  const ctx: any = { cwd: dir, mode: "tui", hasUI: !!options.ui, ui: options.ui, sessionManager: {
    getSessionId: () => assignmentId, getSessionFile: () => join(dir, "session.jsonl"), getEntries: () => entries,
  } };
  workerLifecycle(pi);
  // The real bash-background extension, loaded into the same mocked host as a separate extension.
  const bashHandlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  if (options.bash) {
    bashBackground({
      on: (name: string, handler: Function) => { bashHandlers.set(name, handler); },
      events, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, registerMessageRenderer: () => {},
      getSettings: () => ({}), getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
      sendMessage: (message: any, sendOptions: any) => { sent.push({ message, options: sendOptions }); },
    } as any);
    bashHandlers.get("session_start")!({}, ctx);
  }
  /** Dispatch one native host event to both extensions, as Pi does. */
  const host = async (name: string, event: any = {}) => {
    await bashHandlers.get(name)?.(event, ctx);
    return handlers.get(name)?.(event, ctx);
  };
  await handlers.get("agent_start")!({}, ctx);
  return { handlers, entries, pi, ctx, events, bus, host, tools, sent };
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

// --- Background bash work keeps a bounded assignment open -------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const waitUntil = async (label: string, condition: () => boolean) => {
  for (let deadline = Date.now() + 10_000; !condition(); ) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => realSetTimeout(done, 10));
  }
};
/** Shrinks only bash-background's 10s foreground window so real commands hand off quickly. */
const fastYield = () => {
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => realSetTimeout(fn, ms === 10_000 ? 20 : ms, ...args)) as typeof setTimeout;
};
afterEach(() => { globalThis.setTimeout = realSetTimeout; });

type Fixture = Awaited<ReturnType<typeof fixture>>;
const startJob = async (f: Fixture, command: string) => {
  const result = await f.tools.get("bash").execute(randomUUID(), { command }, undefined, undefined, f.ctx);
  expect(result.structuredContent.status).toBe("running");
  return result.structuredContent.job_id as string;
};
/** One native run ending in an assistant response, through Pi's settle boundaries. */
const finishRun = async (f: Fixture, text: string, outcome = "completed") => {
  const message = response(text, outcome === "completed" ? "stop" : "error");
  const id = randomUUID();
  f.entries.push({ type: "message", id, message });
  await f.host("turn_end", { outcome, message, messageEntryId: id });
  await f.host("agent_before_settle", { outcome });
  await f.host("agent_settled", {});
};
/** Pi starting the wake run for a completion message and admitting it to the conversation. */
const wake = async (f: Fixture, sent: { message: any }) => {
  await f.host("agent_start", {});
  await f.host("message_start", { message: { role: "custom", ...sent.message } });
};

test("idle with running background bash neither completes nor delivers; its single wake run completes the original assignment", async () => {
  fastYield();
  const f = await fixture({ bash: true });
  const pending: number[] = [];
  f.events.on(BASH_PENDING_EVENT, (data: any) => pending.push(data.pending));
  const jobId = await startJob(f, "sleep 0.4; echo built");
  await finishRun(f, "Build started in the background.");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", generation: 1, backgroundJobs: 1 });
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);

  await waitUntil("completion message", () => f.sent.length === 1);
  expect(f.sent[0]).toMatchObject({ message: { customType: "bash-job-complete", details: { jobId, state: "completed", exitCode: 0 } }, options: { deliverAs: "steer", triggerTurn: true } });
  // Finished but not yet admitted: still pending, so still unresolved.
  expect(pending).toEqual([1]);
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", backgroundJobs: 1 });
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);

  await wake(f, f.sent[0]!);
  expect(pending).toEqual([1, 0]);
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", generation: 2 });
  await finishRun(f, "Build passed: built");
  const receipt = readAssignmentReceipt(assignmentId)!;
  expect(receipt).toMatchObject({ outcome: "completed", generation: 2, requestId: assignmentId, resultHash: hashText("Build passed: built") });
  expect(receipt.backgroundJobs).toBeUndefined();
  expect(readAssignmentResult(assignmentId, receipt.resultHash!)).toBe("Build passed: built");
  expect(f.sent).toHaveLength(1);
  await f.host("session_shutdown");
});

test("multiple background jobs keep the assignment open until the last wake run settles", async () => {
  fastYield();
  const f = await fixture({ bash: true });
  await startJob(f, "sleep 0.2; echo first");
  await startJob(f, "sleep 0.8; echo second");
  await finishRun(f, "");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", backgroundJobs: 2 });

  await waitUntil("first completion", () => f.sent.length === 1);
  await wake(f, f.sent[0]!);
  await finishRun(f, "First job done; second still running.");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", generation: 2, backgroundJobs: 1 });
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);

  await waitUntil("second completion", () => f.sent.length === 2);
  await wake(f, f.sent[1]!);
  await finishRun(f, "Both jobs passed");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "completed", generation: 3, resultHash: hashText("Both jobs passed") });
  expect(f.sent).toHaveLength(2);
  await f.host("session_shutdown");
});

test("a job finishing inside the run is admitted by steer and settles normally", async () => {
  fastYield();
  const f = await fixture({ bash: true });
  await startJob(f, "sleep 0.1; echo quick");
  await waitUntil("completion", () => f.sent.length === 1);
  await f.host("message_start", { message: { role: "custom", ...f.sent[0]!.message } });
  await finishRun(f, "Quick job passed");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "completed", generation: 1 });
  await f.host("session_shutdown");
});

test("a completion during Pi's settle tail is held, sent at agent_settled, and still blocks completion", async () => {
  fastYield();
  const f = await fixture({ bash: true });
  await startJob(f, "sleep 0.2; echo late");
  const message = response("Waiting is not a result");
  f.entries.push({ type: "message", id: "tail", message });
  await f.host("turn_end", { outcome: "completed", message, messageEntryId: "tail" });
  await f.host("agent_before_settle", { outcome: "completed" });
  await new Promise((done) => realSetTimeout(done, 600));
  // A steer here could be stranded after Pi's last queued-message check.
  expect(f.sent).toHaveLength(0);
  await f.host("agent_settled", {});
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", backgroundJobs: 1 });
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
  await wake(f, f.sent[0]!);
  await finishRun(f, "Late job passed");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "completed", generation: 2 });
  await f.host("session_shutdown");
});

test("parent stop's Escape stops idle background work and records an interruption, never success", async () => {
  fastYield();
  const inputs: Array<(data: string) => unknown> = [];
  const f = await fixture({ bash: true, ui: { onTerminalInput: (handler: any) => { inputs.push(handler); return () => {}; }, setWidget: () => {} } });
  f.handlers.get("session_start")!({}, f.ctx);
  let stops = 0;
  f.events.on(BASH_STOP_EVENT, () => { stops += 1; });
  await startJob(f, "sleep 5; echo never");
  await finishRun(f, "Started");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", backgroundJobs: 1 });
  for (const input of inputs) input("\x1b");
  // Escape without the parent's cancellation intent is not a stop.
  expect(stops).toBe(0);
  expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("running");
  writeCancellationIntent(readAssignmentReceipt(assignmentId)!);
  for (const input of inputs) input("\x1b");
  expect(stops).toBe(1);
  expect(readAssignmentReceipt(assignmentId)!.outcome).toBe("aborted");
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
  await new Promise((done) => realSetTimeout(done, 200));
  expect(f.sent).toHaveLength(0);
  await f.host("session_shutdown");
});

test("all background work stopped while idle without a wake records an interruption", async () => {
  const f = await fixture();
  f.events.emit(BASH_PENDING_EVENT, { pending: 1 });
  await finishRun(f, "Started");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", backgroundJobs: 1 });
  f.events.emit(BASH_PENDING_EVENT, { pending: 0 });
  const receipt = readAssignmentReceipt(assignmentId)!;
  expect(receipt.outcome).toBe("aborted");
  expect(receipt.backgroundJobs).toBeUndefined();
  expect(existsSync(resultPathForAssignment(assignmentId))).toBe(false);
});

test("a model error with background work pending stays open; an aborted run is still an interruption", async () => {
  const f = await fixture();
  f.events.emit(BASH_PENDING_EVENT, { pending: 1 });
  await finishRun(f, "partial", "error");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "running", backgroundJobs: 1 });
  await f.host("agent_start", {});
  await finishRun(f, "", "aborted");
  expect(readAssignmentReceipt(assignmentId)).toMatchObject({ outcome: "aborted", generation: 2 });
});
