import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAssignmentReceipt } from "./artifacts.ts";
import { recoverAbsentTask, setHerdrTestTransportForTests } from "./herdr.ts";
import { availableTaskActions, isActiveTask, type TaskHandle } from "./state.ts";
let temp: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  temp = mkdtempSync(join(tmpdir(), "routing-recovery-")); process.env.PI_CODING_AGENT_DIR = temp;
  setHerdrTestTransportForTests(async (pi, args) => (await pi.exec("herdr", args)).stdout);
});
afterEach(() => {
  setHerdrTestTransportForTests(); rmSync(temp, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
});
const task = (): TaskHandle => ({ handle: "rt-recovery", assignmentId: "c33e0d18-695a-48c1-8bca-7d17f9895725", requestId: "c33e0d18-695a-48c1-8bca-7d17f9895725", parentSessionId: "parent",
  sessionId: "session", sessionPath: join(temp, "session.jsonl"), agentName: "old-worker", paneId: "w1:p2", terminalId: "old-terminal",
  capabilities: [], route: "sol", model: "provider/model", thinking: "low", target: "herdr", label: "Preserved worker", state: "unknown",
  cwd: temp, startedAt: 1, transitions: 0, notifiedStates: [] });
const inventory = (agents: any[] = [], panes: any[] = []) => ({ exec: async (_: string, args: string[]) => ({ stdout: JSON.stringify({ result: args[0] === "pane" ? { panes } : { agents } }) }) }) as any;
async function exitedPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.on("exit", () => resolve()); child.on("error", reject); }); return child.pid!;
}
function receipt(t: TaskHandle, pid: number) {
  writeAssignmentReceipt({ version: 1, assignmentId: t.assignmentId!, requestId: t.requestId!, sessionId: t.sessionId!, sessionPath: t.sessionPath!,
    paneId: t.paneId!, terminalId: t.terminalId!, generation: 1, outcome: "running", lastActivityAt: 1, workerPid: pid });
}
test("dead executor with a saved conversation becomes suspended and recoverable, not unknown active work", async () => {
  const t = task(); writeFileSync(t.sessionPath!, JSON.stringify({ type: "session", id: t.sessionId }) + "\n"); receipt(t, await exitedPid());
  const patch = await recoverAbsentTask(inventory(), t); expect(patch?.state).toBe("suspended");
  Object.assign(t, patch); expect(isActiveTask(t)).toBe(false); expect(availableTaskActions(t)).toContain("resume"); expect(availableTaskActions(t)).toContain("open");
  expect(t.sessionPath).toBe(join(temp, "session.jsonl"));
});
test("startup that never registered and whose pane disappeared can be cleared", async () => {
  const t = task(); delete t.terminalId; delete t.sessionPath;
  const patch = await recoverAbsentTask(inventory(), t); expect(patch?.state).toBe("failed");
  Object.assign(t, patch); expect(availableTaskActions(t)).toContain("clear");
});
test("neither missing registry nor a reused pane authorizes replacing a still-running process", async () => {
  const t = task(); receipt(t, process.pid);
  expect(await recoverAbsentTask(inventory(), t)).toBeUndefined();
  receipt(t, await exitedPid());
  expect(await recoverAbsentTask(inventory([{ pane_id: t.paneId }]), t)).toBeUndefined();
});
test("missing receipts, present startup panes, pending Pi and unavailable inventory stay unresolved", async () => {
  const t = task(); expect(await recoverAbsentTask(inventory(), t)).toBeUndefined();
  delete t.terminalId; delete t.sessionPath;
  expect(await recoverAbsentTask(inventory([], [{ pane_id: t.paneId }]), t)).toBeUndefined();
  expect(await recoverAbsentTask(inventory([{ agent: "pi", launch_pending: true }]), t)).toBeUndefined();
  expect(await recoverAbsentTask({ exec: async () => ({ stdout: '{}' }) } as any, t)).toBeUndefined();
});

test("terminal receipts, pending delivery and stale generations remain with normal result handling", async () => {
  const t = task(); writeFileSync(t.sessionPath!, JSON.stringify({ type: "session", id: t.sessionId }) + "\n"); const pid = await exitedPid();
  for (const outcome of ["completed", "error"] as const) {
    writeAssignmentReceipt({ version: 1, assignmentId: t.assignmentId!, requestId: t.requestId!, sessionId: t.sessionId!, sessionPath: t.sessionPath!,
      paneId: t.paneId!, terminalId: t.terminalId!, generation: 1, outcome, lastActivityAt: 1, workerPid: pid });
    expect(await recoverAbsentTask(inventory(), t)).toBeUndefined();
  }
  receipt(t, pid); t.pendingCompletion = true; expect(await recoverAbsentTask(inventory(), t)).toBeUndefined();
  t.pendingCompletion = false; t.minimumGeneration = 2; expect(await recoverAbsentTask(inventory(), t)).toBeUndefined();
  t.minimumGeneration = 1; t.requestId = "different"; expect(await recoverAbsentTask(inventory(), t)).toBeUndefined();
});

test("a failed pre-reboot worker keeps its failure but exposes saved-session recovery after status inspection", async () => {
  const t = task(); t.state = "failed"; t.error = "Worker terminal identity is unverified or replaced";
  writeFileSync(t.sessionPath!, JSON.stringify({ type: "session", id: t.sessionId }) + "\n");
  writeAssignmentReceipt({ version: 1, assignmentId: t.assignmentId!, requestId: t.requestId!, sessionId: t.sessionId!, sessionPath: t.sessionPath!,
    paneId: t.paneId!, terminalId: t.terminalId!, generation: 1, outcome: "error", lastActivityAt: 1, workerPid: await exitedPid() });
  Object.assign(t, await recoverAbsentTask(inventory(), t));
  expect(t.state).toBe("failed"); expect(t.error).toContain("terminal identity");
  expect(availableTaskActions(t)).toContain("open"); expect(availableTaskActions(t)).toContain("resume");
});
