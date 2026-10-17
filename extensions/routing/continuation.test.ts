import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savedRoutedSession, validateContinuation, withSessionStartLock } from "./continuation.ts";
import { askPathForAssignment, atomicWriteArtifact, writeAssignmentReceipt, readAssignmentReceipt } from "./artifacts.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";
import { continueRoutedTask, type LaunchDependencies } from "./launch.ts";
import { ExplicitRouteRetryGuard } from "./workflow.ts";
import type { TaskHandle } from "./state.ts";

setHerdrTestTransportForTests(async (pi: any, args, timeout) => {
  const result = await pi.exec("herdr", args, { timeout });
  if (result.code !== 0) throw new Error(result.stderr || "fixture transport failed");
  return result.stdout;
});
let temp: string;
let previousEnv: Record<string, string | undefined>;
const envNames = ["PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "PI_ROUTED_ROOT_WORKSPACE_ID", "PI_ROUTED_ROOT_TAB_ID"] as const;
beforeEach(() => {
  previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  temp = mkdtempSync(join(tmpdir(), "p3-continuation-"));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: temp, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" });
  delete process.env.PI_ROUTED_ROOT_WORKSPACE_ID;
  delete process.env.PI_ROUTED_ROOT_TAB_ID;
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  for (const key of envNames) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
});
const fixture = () => {
  const sessionId = randomUUID();
  const sessionPath = join(temp, "owned.jsonl");
  const timestamp = new Date().toISOString();
  // Native Pi entries form a real branch; SessionManager.open/buildSessionContext is not mocked.
  writeFileSync(sessionPath, [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: temp },
    { type: "model_change", id: "a0000001", parentId: null, timestamp, provider: "openai-codex", modelId: "gpt-6-luna" },
    { type: "thinking_level_change", id: "a0000002", parentId: "a0000001", timestamp, thinkingLevel: "high" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const task: TaskHandle = {
    handle: "rt-original", assignmentId: randomUUID(), parentSessionId: "parent-session", sessionId, sessionPath,
    paneId: "w1:p9", terminalId: "old-terminal", agentName: "old-worker", cwd: temp,
    route: "luna", routeExplicit: true, target: "herdr", model: "openai-codex/gpt-6-luna", thinking: "high",
    readonly: true, capabilities: [], paneRetention: "close", label: "Owned task", state: "completed",
    startedAt: 1, endedAt: 2, completionNotifiedAt: 3, transitions: 1, notifiedStates: ["completed"],
  };
  task.requestId = task.assignmentId;
  const ctx: any = { cwd: temp, sessionManager: { getSessionId: () => "parent-session" }, modelRegistry: {
    find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true,
  } };
  const receipt = (workerPid?: number) => writeAssignmentReceipt({ version: 1, assignmentId: task.assignmentId!, requestId: task.requestId!,
    sessionId, sessionPath, paneId: task.paneId!, terminalId: task.terminalId!, generation: 1,
    outcome: "completed", lastActivityAt: 2, workerPid });
  const pi: any = { exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" }) };
  return { task, ctx, pi, receipt };
};
const exitedOwnedPid = async () => {
  // Executed only by a future test run, never during definition authoring.
  const child = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))); });
  if (!pid) throw new Error("Owned fixture process has no PID");
  return pid;
};

test("reads the exact owned native session profile and JSONL byte boundary", () => {
  const { task } = fixture();
  expect(savedRoutedSession(task)).toEqual({ path: realpathSync(task.sessionPath!), id: task.sessionId, cwd: temp,
    model: { provider: "openai-codex", modelId: "gpt-6-luna" }, thinking: "high", bytes: statSync(task.sessionPath!).size });
});
for (const field of ["sessionId", "cwd", "capabilities", "assignmentId", "parentSessionId"] as const) {
  test(`never guesses an incomplete saved profile: ${field}`, () => {
    const { task } = fixture();
    expect(() => savedRoutedSession({ ...task, [field]: undefined })).toThrow("incomplete");
  });
}
for (const patch of [{ sessionId: "foreign" }, { cwd: tmpdir() }] as const) {
  test(`rejects a conflicting owned header ${Object.keys(patch)[0]}`, () => {
    const { task } = fixture();
    expect(() => savedRoutedSession({ ...task, ...patch })).toThrow("conflicts");
  });
}
test("rejects a native session without a saved model instead of choosing a default", () => {
  const { task } = fixture();
  writeFileSync(task.sessionPath!, JSON.stringify({ type: "session", version: 3, id: task.sessionId, timestamp: new Date().toISOString(), cwd: temp }) + "\n");
  expect(() => savedRoutedSession(task)).toThrow("model/thinking");
});
for (const patch of [{ state: "running" }, { state: "unknown" }, { state: "lost" }, { pendingCompletion: true }, { completionNotifiedAt: undefined }, { background: true }] as const) {
  test(`rejects unresolved continuation ${JSON.stringify(patch)}`, async () => {
    const { task, pi, ctx } = fixture();
    await expect(validateContinuation(pi, ctx, { ...task, ...patch }, [])).rejects.toThrow("unresolved");
  });
}
test("rejects a foreign parent before inspecting or launching the worker", async () => {
  const { task, pi, ctx } = fixture();
  task.parentSessionId = "other-parent";
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("parent");
});
for (const status of ["waiting", "answered"] as const) {
  test(`a ${status} question prevents continuation, including a reply not yet consumed`, async () => {
    const { task, pi, ctx } = fixture();
    atomicWriteArtifact(askPathForAssignment(task.assignmentId!), JSON.stringify({ version: 1, id: randomUUID(), assignmentId: task.assignmentId,
      requestId: task.requestId, parentSessionId: task.parentSessionId, sessionId: task.sessionId, paneId: task.paneId, terminalId: task.terminalId,
      question: "Which direction?", status, createdAt: 1, ...(status === "answered" ? { reply: "Use A", replyId: randomUUID() } : {}) }));
    await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("outstanding question");
  });
}
test("empty Herdr inventory alone cannot prove the original native process exited", async () => {
  const { task, pi, ctx, receipt } = fixture();
  receipt();
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("process identity is unverified");
  receipt(process.pid);
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("has not exited");
});
test("delivered completion and explicit stop accept an owned exited native PID", async () => {
  const { task, pi, ctx, receipt } = fixture();
  receipt(await exitedOwnedPid());
  expect((await validateContinuation(pi, ctx, task, [task])).id).toBe(task.sessionId);
  task.state = "stopped"; task.completionNotifiedAt = undefined;
  expect((await validateContinuation(pi, ctx, task, [task])).id).toBe(task.sessionId);
});
for (const agent of [
  { pane_id: "w1:p9" }, { terminal_id: "old-terminal" }, { agent: "pi", launch_pending: true },
]) {
  test(`rejects live or pending Herdr representation ${JSON.stringify(agent)}`, async () => {
    const { task, pi, ctx, receipt } = fixture(); receipt(await exitedOwnedPid());
    pi.exec = async () => ({ code: 0, stdout: JSON.stringify({ result: { agents: [agent] } }), stderr: "" });
    await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow(/representation|pending Pi/);
  });
}
test("rejects a same-session alias, unresolved managed task, unavailable inventory and missing model auth", async () => {
  const { task, pi, ctx, receipt } = fixture(); receipt(await exitedOwnedPid());
  await expect(validateContinuation(pi, ctx, task, [{ ...task, handle: "rt-other", state: "unknown" }])).rejects.toThrow("already has active");
  pi.exec = async () => ({ code: 0, stdout: JSON.stringify({ result: { agents: [{ agent_session: { value: task.sessionPath } }] } }), stderr: "" });
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("live representation");
  pi.exec = async () => ({ code: 0, stdout: '{"result":{}}', stderr: "" });
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("inventory is unverified");
  ctx.modelRegistry.hasConfiguredAuth = () => false;
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("no substitute");
});
test("canonical startup lock excludes a second activation through a symlink and releases on failure", async () => {
  const { task } = fixture(); const alias = join(temp, "alias.jsonl"); symlinkSync(task.sessionPath!, alias);
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = withSessionStartLock(task.sessionPath!, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await started;
  try { await expect(withSessionStartLock(alias, async () => { throw new Error("must not activate"); })).rejects.toThrow("startup lock exists"); }
  finally { release(); await held; }
  await expect(withSessionStartLock(alias, async () => { throw new Error("operation failed"); })).rejects.toThrow("operation failed");
  expect(await withSessionStartLock(alias, async () => "released")).toBe("released");
});
test("dead startup claim is reported as stale and never stolen", async () => {
  const { task } = fixture();
  const lock = join(temp, "state", "routed-session-starts", `${createHash("sha256").update(realpathSync(task.sessionPath!)).digest("hex")}.lock`);
  mkdirSync(lock, { recursive: true });
  const owner = { pid: await exitedOwnedPid(), generation: randomUUID(), sessionPath: task.sessionPath };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  let called = false;
  try { await withSessionStartLock(task.sessionPath!, async () => { called = true; }); throw new Error("expected stale rejection"); }
  catch (error: any) { expect(error.detail.category).toBe("stale_session_claim"); expect(error.detail.retrySafe).toBe(false); }
  expect(called).toBe(false); expect(existsSync(join(lock, "owner.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(owner);
});
for (const afterExecutorLoss of [false, true]) test(`continuation ${afterExecutorLoss ? "after executor loss" : "after completion"} creates a new assignment on the same session, preserving profile and isolating usage`, async () => {
  const { task, ctx, receipt } = fixture(); receipt(await exitedOwnedPid());
  if (afterExecutorLoss) {
    task.state = "unknown"; task.completionNotifiedAt = undefined;
    writeAssignmentReceipt({ ...readAssignmentReceipt(task.assignmentId!)!, outcome: "running" });
  }
  task.capabilities = ["memory"];
  const original = structuredClone(task); const calls: string[][] = []; const watched: TaskHandle[] = [];
  const tasks = new Map([[task.handle, task]]);
  const deps: LaunchDependencies = {
    pi: { exec: async (_command: string, args: string[]) => {
      calls.push(args); const key = args.slice(0, 2).join(" ");
      const agent = { pane_id: "w1:p2", terminal_id: "new-terminal", interactive_ready: true, agent_status: "idle", agent_session: { value: task.sessionPath } };
      const result = key === "agent list" ? { agents: [] } : key === "tab list" ? { tabs: [] } : key === "tab create" ? { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } : key === "agent start" || key === "agent get" ? { agent } : {};
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    } } as any,
    taskHandles: tasks, workflowLaunches: new Map(), routeRetryGuard: new ExplicitRouteRetryGuard(),
    recordDecision: () => { throw new Error("must not reclassify"); }, resolveRoute: () => { throw new Error("must not substitute model"); },
    trackTask: (tracked) => tasks.set(tracked.handle, tracked), watchHerdrTask: (tracked) => watched.push(tracked),
  };
  const boundary = statSync(task.sessionPath!).size;
  const result = await continueRoutedTask(deps, ctx, task, "Follow up only; do not replay the original.");
  const next = result.task!;
  if (afterExecutorLoss) {
    expect(task.state).toBe("suspended"); expect(task.sessionPath).toBe(original.sessionPath);
  } else expect(task).toEqual(original);
  expect(next.handle).not.toBe(task.handle); expect(next.assignmentId).not.toBe(task.assignmentId);
  expect(next.continuedFrom).toBe(task.handle); expect(next.sessionId).toBe(task.sessionId); expect(next.sessionPath).toBe(realpathSync(task.sessionPath!));
  expect(next.cwd).toBe(task.cwd); expect(next.model).toBe(task.model); expect(next.thinking).toBe(task.thinking); expect(next.readonly).toBe(true); expect(next.capabilities).toEqual(["memory"]);
  expect(next.usageStartOffset).toBe(boundary); expect(next.usageOffset).toBe(boundary); expect(next.estimatedCost).toBe(0); expect(next.costComplete).toBe(true);
  expect(next.instructionIds).toEqual([next.assignmentId]); expect(watched).toEqual([next]);
  const start = calls.find((args) => args[1] === "start")!;
  expect(start[start.indexOf("--session") + 1]).toBe(next.sessionPath); expect(start).not.toContain("--session-id");
  expect(start[start.indexOf("--model") + 1]).toBe(task.model); expect(start[start.indexOf("--thinking") + 1]).toBe("high");
  expect(start).toContain("--no-mcp");
  const prompts = calls.filter((args) => args[1] === "prompt"); expect(prompts).toHaveLength(1);
  expect(prompts[0][3]).toStartWith(`p3:routed-request ${next.assignmentId}\nFollow up only; do not replay the original.\n`);
  expect(prompts[0][3]).not.toContain("p3:routed-request " + task.assignmentId);
});

for (const field of ["sessionId", "paneId", "terminalId"] as const) {
  test(`dead PID on a foreign original ${field} receipt never authorizes continuation`, async () => {
    const { task, pi, ctx, receipt } = fixture(); receipt(await exitedOwnedPid());
    writeAssignmentReceipt({ ...readAssignmentReceipt(task.assignmentId!)!, [field]: "foreign" });
    await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("process identity is unverified");
  });
}
test("missing saved model in the registry never selects a substitute", async () => {
  const { task, pi, ctx, receipt } = fixture(); receipt(await exitedOwnedPid());
  ctx.modelRegistry.find = () => undefined;
  await expect(validateContinuation(pi, ctx, task, [])).rejects.toThrow("no substitute");
});

test("a suspended worker resumes the exact saved conversation without requiring stop", async () => {
  const { task, pi, ctx, receipt } = fixture(); receipt(await exitedOwnedPid());
  task.state = "suspended"; task.presence = "lost"; task.completionNotifiedAt = undefined;
  expect((await validateContinuation(pi, ctx, task, [task])).path).toBe(realpathSync(task.sessionPath!));
});
