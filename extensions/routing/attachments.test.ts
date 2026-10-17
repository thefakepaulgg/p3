import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAssignmentResult, saveAssignmentResult, writeAssignmentReceipt } from "./artifacts.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";
import { aggregateUsageCoverage } from "./usage.ts";
import type { TaskHandle } from "./state.ts";
import { assertSessionUnattached, closeAttachment, listParentAttachments, openSavedAttachment, readAttachmentRecord, refreshAttachment } from "./attachments.ts";
import { readAttachmentPresence, writeAttachmentPresence } from "./attachment-store.ts";

const LIFECYCLE = fileURLToPath(new URL("./attachment-lifecycle.ts", import.meta.url));
const envNames = ["PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "PI_ROUTED_ROOT_WORKSPACE_ID", "PI_ROUTED_ROOT_TAB_ID", "PI_ROUTING_MANIFEST"] as const;
let temp: string;
let previousEnv: Record<string, string | undefined>;
let calls: string[][];
let agents: any[];
let live: { child: ChildProcess; agent: any } | undefined;
let childState: string;

/** A real attached process: the lifecycle runs in a separate PID that genuinely exits on native shutdown. */
const childScript = (path: string) => writeFileSync(path, `
import life from ${JSON.stringify(LIFECYCLE)};
import { readFileSync } from "node:fs";
const handlers = {};
life({ on: (event, handler) => (handlers[event] ??= []).push(handler) });
const state = () => JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8"));
const ctx = { hasUI: true, isIdle: () => state().idle, hasPendingMessages: () => false,
  ui: { getEditorText: () => state().editor, notify() {} },
  sessionManager: { getSessionFile: () => process.env.FIXTURE_SESSION_PATH, getSessionId: () => process.env.FIXTURE_SESSION_ID },
  shutdown: async () => { for (const h of handlers.session_shutdown ?? []) await h({ type: "session_shutdown", reason: "quit" }, ctx); process.exit(0); } };
for (const h of handlers.session_start ?? []) await h({ type: "session_start", reason: "startup" }, ctx);
console.log("ready");
setInterval(() => {}, 1000);
`);

const exitedPid = async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
};
const assistant = (id: string, parentId: string, cost: number) => JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(),
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "openai-codex", model: "gpt-6-luna", stopReason: "stop", usage: { cost: { total: cost } } } }) + "\n";

beforeEach(() => {
  previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  temp = realpathSync(mkdtempSync(join(tmpdir(), "p3-attach-")));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: temp, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" });
  for (const key of ["PI_ROUTED_ROOT_WORKSPACE_ID", "PI_ROUTED_ROOT_TAB_ID", "PI_ROUTING_MANIFEST"] as const) delete process.env[key];
  calls = []; agents = []; live = undefined;
  childState = join(temp, "child-state.json");
  writeFileSync(childState, JSON.stringify({ idle: true, editor: "" }));
  childScript(join(temp, "child.ts"));
});
afterEach(() => {
  setHerdrTestTransportForTests(undefined);
  if (live?.child.exitCode === null) live.child.kill("SIGKILL");
  rmSync(temp, { recursive: true, force: true });
  for (const key of envNames) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
});

async function fixture(options: { paneClosed?: boolean } = {}) {
  const sessionId = randomUUID();
  const sessionPath = join(temp, "owned.jsonl");
  const timestamp = new Date().toISOString();
  writeFileSync(sessionPath, [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: temp },
    { type: "model_change", id: "a0000001", parentId: null, timestamp, provider: "openai-codex", modelId: "gpt-6-luna" },
    { type: "thinking_level_change", id: "a0000002", parentId: "a0000001", timestamp, thinkingLevel: "high" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n" + assistant("a0000003", "a0000002", 0.5));
  const task: TaskHandle = {
    handle: "rt-original", assignmentId: randomUUID(), parentSessionId: "parent-session", sessionId, sessionPath,
    paneId: "w1:p9", terminalId: "old-terminal", agentName: "old-worker", cwd: temp, workerManifestPath: join(temp, "routing-pane-w1_p1.json"),
    route: "luna", routeExplicit: true, target: "herdr", model: "openai-codex/gpt-6-luna", thinking: "high",
    readonly: true, capabilities: [], paneRetention: "close", label: "Owned task", state: "completed",
    startedAt: 1, endedAt: 2, completionNotifiedAt: 3, transitions: 1, notifiedStates: ["completed"], paneClosedAt: options.paneClosed === false ? undefined : 3,
  };
  task.requestId = task.assignmentId;
  writeAssignmentReceipt({ version: 1, assignmentId: task.assignmentId!, requestId: task.requestId!, sessionId, sessionPath, paneId: task.paneId!,
    terminalId: task.terminalId!, generation: 1, outcome: "completed", lastActivityAt: 2, workerPid: await exitedPid() });
  const resultHash = saveAssignmentResult(task.requestId!, 1, sessionId, "a0000003", "original result");
  const context = (parent: string): any => ({ cwd: temp, sessionManager: { getSessionId: () => parent },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true } });
  setHerdrTestTransportForTests(async (_pi, args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const ok = (result: object = {}) => JSON.stringify({ result });
    if (key === "agent list") return ok({ agents });
    if (key === "tab create") return ok({ tab: { tab_id: "w1:t7" }, root_pane: { pane_id: "w1:p7" } });
    if (key === "agent start") {
      const create = calls.findLast((call) => call[0] === "tab" && call[1] === "create")!;
      const createEnv = Object.fromEntries(create.flatMap((arg, i) => create[i - 1] === "--env" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []));
      const child = spawn(process.execPath, [join(temp, "child.ts")], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...createEnv,
        HERDR_PANE_ID: "w1:p7", FIXTURE_STATE: childState, FIXTURE_SESSION_PATH: sessionPath, FIXTURE_SESSION_ID: sessionId } });
      await new Promise<void>((resolve, reject) => { child.stdout!.on("data", (chunk) => String(chunk).includes("ready") && resolve()); child.once("exit", () => reject(new Error("child exited"))); });
      live = { child, agent: { name: args[2], pane_id: "w1:p7", terminal_id: "term-a", agent_status: "idle", interactive_ready: true, agent_session: { value: sessionPath } } };
      return ok({ agent: live.agent });
    }
    if (key === "agent get") {
      if (args[2] === "old-worker" && options.paneClosed === false) return ok({ agent: { pane_id: "w1:p9", terminal_id: "old-terminal", agent_session: { value: sessionPath } } });
      if (live && live.child.exitCode === null) return ok({ agent: live.agent });
      throw new Error("agent_not_found: no agent");
    }
    if (key === "pane list") return ok({ panes: [{ pane_id: "w1:p7", tab_id: "w1:t7" }] });
    if (["pane focus", "tab close", "pane close"].includes(key)) return ok();
    throw new Error(`unexpected herdr call ${key}`);
  });
  return { task, sessionPath, sessionId, resultHash, ctx: context("parent-session"), other: context("other-parent"), pi: {} as any };
}

test("opens a finished worker's saved session with zero model turns, exact profile and a lifetime claim", async () => {
  const { task, sessionPath, sessionId, resultHash, ctx, other, pi } = await fixture();
  const snapshot = structuredClone(task);
  const prefix = readFileSync(sessionPath);
  const opened = await openSavedAttachment(pi, ctx, task);
  const record = opened.record!;
  expect(record).toMatchObject({ status: "open", handle: task.handle, sourceHandle: task.handle, parentSessionId: "parent-session", sessionId, sessionPath,
    paneId: "w1:p7", tabId: "w1:t7", terminalId: "term-a", workerPid: live!.child.pid, usageStartOffset: prefix.length, usageOffset: prefix.length });
  // Zero model turns: nothing was typed or prompted into the attachment.
  expect(calls.some((call) => ["agent prompt", "agent send-keys"].includes(call.slice(0, 2).join(" ")))).toBe(false);
  const create = calls.find((call) => call.slice(0, 2).join(" ") === "tab create")!;
  expect(create).not.toContain("--no-focus");
  expect(create).toEqual(expect.arrayContaining([`PI_ROUTED_ATTACHMENT_ID=${record.attachmentId}`, `PI_ROUTING_MANIFEST=${task.workerManifestPath}`, "PI_ROUTED_READONLY=1", "PI_ROUTED_ROOT_TAB_ID=w1:t1"]));
  const start = calls.find((call) => call.slice(0, 2).join(" ") === "agent start")!;
  expect(start).toEqual(expect.arrayContaining(["--pane", "w1:p7", "--session", sessionPath, "--model", "openai-codex/gpt-6-luna", "--thinking", "high", "--tools", "--no-mcp", "--extension", LIFECYCLE]));
  expect(start.join(" ")).not.toContain("worker-lifecycle");
  expect(start).not.toContain("--name");
  expect(start[start.indexOf("--exclude-tools") + 1]).toContain("subagent");
  expect(readAttachmentPresence(record.attachmentId)).toMatchObject({ pid: live!.child.pid, sessionId, paneId: "w1:p7" });
  expect(readFileSync(sessionPath).equals(prefix)).toBe(true);

  // Exclusion: continuation and a second parent are refused; the owning parent focuses the existing attachment.
  expect(() => assertSessionUnattached(sessionPath)).toThrow("attached for human use");
  await expect(openSavedAttachment(pi, other, { ...task, parentSessionId: "other-parent" })).rejects.toThrow("another parent");
  const before = calls.length;
  expect((await openSavedAttachment(pi, ctx, task)).record?.attachmentId).toBe(record.attachmentId);
  expect(calls.slice(before).some((call) => call.slice(0, 2).join(" ") === "pane focus" && call[2] === "w1:p7")).toBe(true);
  expect(calls.filter((call) => call.slice(0, 2).join(" ") === "tab create")).toHaveLength(1);
  // Durable across parent restart: state is on disk, not in this process.
  expect(listParentAttachments("parent-session").map((item) => item.attachmentId)).toEqual([record.attachmentId]);
  expect(listParentAttachments("other-parent")).toEqual([]);

  // A human follow-up appends; the completed result and source task stay unchanged.
  appendFileSync(sessionPath, assistant("b0000001", "a0000003", 0.25));
  writeFileSync(childState, JSON.stringify({ idle: true, editor: "unsent draft" }));
  await expect(closeAttachment(pi, ctx, record.attachmentId)).rejects.toThrow("draft");
  expect(live!.child.exitCode).toBeNull();
  writeFileSync(childState, JSON.stringify({ idle: false, editor: "" }));
  await expect(closeAttachment(pi, ctx, record.attachmentId)).rejects.toThrow("busy");
  await expect(closeAttachment(pi, other, record.attachmentId)).rejects.toThrow("another parent");
  writeFileSync(childState, JSON.stringify({ idle: true, editor: "" }));
  const closed = (await closeAttachment(pi, ctx, record.attachmentId)).record;
  expect(live!.child.exitCode).toBe(0);
  expect(closed).toMatchObject({ status: "closed", usageStartOffset: prefix.length, usageOffset: statSync(sessionPath).size, estimatedCost: 0.25, costKnown: true, costComplete: true });
  expect(calls.some((call) => call.slice(0, 2).join(" ") === "tab close" && call[2] === "w1:t7")).toBe(true);
  expect(readFileSync(sessionPath).subarray(0, prefix.length).equals(prefix)).toBe(true);
  expect(readAssignmentResult(task.requestId!, resultHash)).toBe("original result");
  expect(task).toEqual(snapshot);
  expect(() => assertSessionUnattached(sessionPath)).not.toThrow();

  // Reopen gets a disjoint window; aggregation counts each byte once.
  const second = (await openSavedAttachment(pi, ctx, task)).record!;
  expect(second.usageStartOffset).toBe(closed.usageOffset);
  appendFileSync(sessionPath, assistant("b0000002", "b0000001", 0.125));
  writeFileSync(childState, JSON.stringify({ idle: true, editor: "" }));
  const secondClosed = (await closeAttachment(pi, ctx, second.attachmentId)).record;
  const coverage = aggregateUsageCoverage({ cost: 1, known: true, complete: true }, [closed, secondClosed].map((item) => ({ ...item, state: "completed" as const })));
  expect(coverage).toMatchObject({ cost: 1.375, complete: true, missingSources: 0 });
});

test("focuses a retained original pane for inspection instead of activating its session", async () => {
  const { task, ctx, pi } = await fixture({ paneClosed: false });
  const opened = await openSavedAttachment(pi, ctx, task);
  expect(opened.record).toBeUndefined();
  expect(calls.some((call) => call.slice(0, 2).join(" ") === "pane focus" && call[2] === "w1:p9")).toBe(true);
  expect(calls.some((call) => call.slice(0, 2).join(" ") === "tab create")).toBe(false);
  expect(task.paneClosedAt).toBeUndefined();
});

test("never activates an incomplete legacy profile", async () => {
  const { task, ctx, pi } = await fixture();
  await expect(openSavedAttachment(pi, ctx, { ...task, cwd: undefined })).rejects.toThrow("incomplete");
  expect(calls.some((call) => call.slice(0, 2).join(" ") === "tab create")).toBe(false);
});

test("crash: claim held while unverifiable, finalized as partial only after proven exit and absence", async () => {
  const { task, sessionPath, ctx, pi } = await fixture();
  const record = (await openSavedAttachment(pi, ctx, task)).record!;
  appendFileSync(sessionPath, assistant("c0000001", "a0000003", 0.5));
  live!.child.kill("SIGKILL");
  await new Promise((resolve) => live!.child.once("exit", resolve));
  agents = [{ agent: "pi", pane_id: "w1:p7", terminal_id: "term-a" }];
  expect((await refreshAttachment(pi, record.attachmentId)).status).toBe("unknown");
  expect(() => assertSessionUnattached(sessionPath)).toThrow("attached");
  await expect(openSavedAttachment(pi, ctx, task)).rejects.toThrow("unknown");
  agents = [];
  const finalized = await refreshAttachment(pi, record.attachmentId);
  expect(finalized).toMatchObject({ status: "closed", estimatedCost: 0.5, costComplete: false });
  expect(finalized.error).toContain("partial");
  expect(finalized.error).not.toContain("claim retained");
  expect(() => assertSessionUnattached(sessionPath)).not.toThrow();
});

test("session drift refuses parent control", async () => {
  const { task, ctx, pi } = await fixture();
  const record = (await openSavedAttachment(pi, ctx, task)).record!;
  const presence = readAttachmentPresence(record.attachmentId)!;
  writeAttachmentPresence({ ...presence, drift: { reason: "new", sessionId: "other", at: Date.now() } });
  await expect(closeAttachment(pi, ctx, record.attachmentId)).rejects.toThrow("parent control is refused");
  expect(live!.child.exitCode).toBeNull();
  expect(readAttachmentRecord(record.attachmentId)?.status).toBe("open");
});

test("a suspended worker opens its saved native conversation without replaying a prompt", async () => {
  const { task, sessionPath, ctx, pi } = await fixture();
  task.state = "suspended"; task.presence = "lost"; task.paneClosedAt = undefined; task.completionNotifiedAt = undefined;
  const before = readFileSync(sessionPath);
  const opened = await openSavedAttachment(pi, ctx, task);
  expect(opened.record?.sessionPath).toBe(realpathSync(sessionPath));
  expect(readFileSync(sessionPath).equals(before)).toBe(true);
  expect(calls.some(args => args[0] === "agent" && args[1] === "prompt")).toBe(false);
  await closeAttachment(pi, ctx, opened.record!.attachmentId);
});
