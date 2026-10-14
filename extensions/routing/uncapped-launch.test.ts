import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAssignmentReceipt } from "./artifacts.ts";
import { ROUTED_TAB_MAX_PANES, setHerdrTestTransportForTests } from "./herdr.ts";
import { continueRoutedTask, launchRoutedTask, type LaunchDependencies } from "./launch.ts";
import type { TaskHandle } from "./state.ts";
import { ExplicitRouteRetryGuard } from "./workflow.ts";

let temp: string;
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  temp = mkdtempSync(join(tmpdir(), "p3-uncapped-launch-"));
  // No credentials, user extensions, or real Herdr endpoint enter this unit fixture.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: join(temp, "home"), PI_CODING_AGENT_DIR: join(temp, "agent"), PI_OFFLINE: "1",
    HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" });
  mkdirSync(process.env.HOME!, { recursive: true });
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  setHerdrTestTransportForTests(async (pi, args, timeout) => {
    const result = await pi.exec("herdr", args, { timeout });
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  });
});
afterEach(() => {
  setHerdrTestTransportForTests();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(temp, { recursive: true, force: true });
});

function nativeSession(path: string, id: string) {
  const timestamp = new Date().toISOString();
  writeFileSync(path, [
    { type: "session", version: 3, id, timestamp, cwd: temp },
    { type: "model_change", id: "a0000001", parentId: null, timestamp, provider: "openai-codex", modelId: "gpt-6-luna" },
    { type: "thinking_level_change", id: "a0000002", parentId: "a0000001", timestamp, thinkingLevel: "high" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function fixture() {
  const calls: string[][] = [];
  const tabs: Array<{ tab_id: string; label: string; pane_count: number }> = [];
  const panes: Array<{ pane_id: string; tab_id: string }> = [];
  const agents = new Map<string, any>();
  const tasks = new Map<string, TaskHandle>();
  const watched: TaskHandle[] = [];
  const option = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const addPane = (tab: typeof tabs[number]) => {
    const pane = { pane_id: `w1:p${panes.length + 2}`, tab_id: tab.tab_id };
    panes.push(pane); tab.pane_count++;
    return pane;
  };
  const deps: LaunchDependencies = {
    pi: { exec: async (command: string, args: string[]) => {
      expect(command).toBe("herdr"); calls.push(args);
      let result: any;
      switch (args.slice(0, 2).join(" ")) {
        case "tab list": result = { tabs }; break;
        case "tab create": {
          const tab = { tab_id: `w1:t${tabs.length + 2}`, label: option(args, "--label"), pane_count: 0 };
          tabs.push(tab); result = { tab, root_pane: addPane(tab) }; break;
        }
        case "pane list": result = { panes }; break;
        case "pane layout": result = { layout: { panes: [panes.find((pane) => pane.pane_id === option(args, "--pane"))] } }; break;
        case "pane split": {
          const parent = panes.find((pane) => pane.pane_id === option(args, "--pane"))!;
          const tab = tabs.find((tab) => tab.tab_id === parent.tab_id)!;
          expect(tab.pane_count).toBeLessThan(ROUTED_TAB_MAX_PANES);
          result = { pane: addPane(tab) }; break;
        }
        case "agent list": result = { agents: [...agents.values()] }; break;
        case "agent start": {
          const path = args.includes("--session") ? option(args, "--session") : join(temp, `${option(args, "--session-id")}.jsonl`);
          if (!args.includes("--session")) nativeSession(path, option(args, "--session-id"));
          const agent = { pane_id: option(args, "--pane"), terminal_id: `terminal-${agents.size}`, interactive_ready: true,
            agent_status: "idle", agent_session: { value: path } };
          agents.set(args[2], agent); result = { agent }; break;
        }
        case "agent get": result = { agent: agents.get(args[2]) }; break;
        case "agent prompt": result = {}; break;
        default: throw new Error(`Unexpected fake transport request: ${args.join(" ")}`);
      }
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    } } as any,
    taskHandles: tasks, workflowLaunches: new Map(), routeRetryGuard: new ExplicitRouteRetryGuard(),
    recordDecision: () => {},
    resolveRoute: () => ({ route: "luna", config: { label: "Luna", provider: "openai-codex", model: "gpt-6-luna", thinking: "high", purpose: "fixture" } }),
    trackTask: (task) => { tasks.set(task.handle, task); }, watchHerdrTask: (task) => { watched.push(task); },
  };
  const ctx: any = { cwd: temp, sessionManager: { getSessionId: () => "parent-session" }, modelRegistry: {
    find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true,
  } };
  const launch = (index: number, extra = {}) => launchRoutedTask(deps, ctx, { task: `Edit disjoint file ${index}`, description: `Task ${index}`,
    route: "luna", owned_paths: [`file-${index}.ts`], ...extra });
  const fill = async () => { for (let i = 0; i < 6; i++) await launch(i); };
  return { deps, ctx, tasks, calls, tabs, watched, launch, fill };
}

async function previousTask(): Promise<TaskHandle> {
  const id = randomUUID(); const path = join(temp, "previous.jsonl"); nativeSession(path, id);
  // This is an owned local fixture process, not a routed agent/descendant session.
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", env: { ...process.env } });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)));
  });
  if (!pid) throw new Error("Fixture PID missing");
  expect(() => process.kill(pid, 0)).toThrow();
  const task: TaskHandle = { handle: "rt-previous", assignmentId: randomUUID(), parentSessionId: "parent-session", sessionId: id, sessionPath: path,
    paneId: "w1:p-old", terminalId: "terminal-old", cwd: temp, route: "luna", routeExplicit: true, target: "herdr",
    model: "openai-codex/gpt-6-luna", thinking: "high", label: "Previous", readonly: true, capabilities: ["memory"],
    ownedPaths: [join(temp, "previous.ts")], state: "completed", startedAt: 1, endedAt: 2, completionNotifiedAt: 3,
    transitions: 1, notifiedStates: ["completed"] };
  task.requestId = task.assignmentId;
  writeAssignmentReceipt({ version: 1, assignmentId: task.assignmentId!, requestId: task.requestId!, sessionId: id, sessionPath: path,
    paneId: task.paneId!, terminalId: task.terminalId!, generation: 1, outcome: "completed", lastActivityAt: 2, workerPid: pid });
  return task;
}

test("actual fresh launches exceed four active disjoint tasks while tabs remain at four panes", async () => {
  const f = fixture(); await f.fill();
  expect([...f.tasks.values()].filter((task) => task.state === "running" && !task.background)).toHaveLength(6);
  expect(f.watched).toHaveLength(6); expect(ROUTED_TAB_MAX_PANES).toBe(4);
  expect(f.tabs.map((tab) => tab.pane_count)).toEqual([4, 2]);
  expect(f.calls.filter((args) => args[1] === "prompt")).toHaveLength(6);
});

test("path conflicts and unsuccessful or missing dependencies still reject above four active tasks", async () => {
  const f = fixture(); await f.fill(); const calls = f.calls.length;
  for (const path of ["file-0.ts", "file-0.ts/child"]) {
    await expect(f.launch(6, { owned_paths: [path] })).rejects.toThrow("overlapping paths");
  }
  const active = [...f.tasks.values()][0];
  await expect(f.launch(6, { depends_on: [active.handle] })).rejects.toThrow("requires successful completion");
  await expect(f.launch(6, { depends_on: ["rt-missing"] })).rejects.toThrow("Unknown dependency");
  expect(f.calls).toHaveLength(calls); expect(f.tasks.size).toBe(6);
});

test("owned launches still coalesce rather than create another identity above four active tasks", async () => {
  const f = fixture(); await f.fill();
  const owner = { kind: "workflow" as const, runId: "run", stepId: "step", attemptId: "attempt" };
  const first = await f.launch(6, { owner }); const calls = f.calls.length;
  const second = await f.launch(6, { owner });
  expect(second.task).toBe(first.task); expect(second.details.coalesced).toBe(true);
  expect(f.calls).toHaveLength(calls); expect(f.tasks.size).toBe(7);
});

test("actual continuation above four active disjoint tasks preserves exact native session/profile and usage boundary", async () => {
  const f = fixture(); await f.fill(); const previous = await previousTask(); f.tasks.set(previous.handle, previous);
  const original = structuredClone(previous); const bytes = readFileSync(previous.sessionPath!); const boundary = statSync(previous.sessionPath!).size;
  f.deps.resolveRoute = () => { throw new Error("must not reroute continuation"); };
  f.deps.recordDecision = () => { throw new Error("must not reclassify continuation"); };
  const result = await continueRoutedTask(f.deps, f.ctx, previous, "Explicit follow-up only."); const next = result.task!;
  expect(previous).toEqual(original); expect(next.handle).not.toBe(previous.handle); expect(next.assignmentId).not.toBe(previous.assignmentId);
  expect(next.continuedFrom).toBe(previous.handle); expect(next.sessionId).toBe(previous.sessionId);
  expect(next.sessionPath).toBe(realpathSync(previous.sessionPath!)); expect(readFileSync(next.sessionPath!)).toEqual(bytes);
  expect(next.cwd).toBe(previous.cwd); expect(next.model).toBe(previous.model); expect(next.thinking).toBe(previous.thinking);
  expect(next.readonly).toBe(true); expect(next.capabilities).toEqual(["memory"]); expect(next.ownedPaths).toEqual(previous.ownedPaths);
  expect(next.usageStartOffset).toBe(boundary); expect(next.usageOffset).toBe(boundary); expect(next.estimatedCost).toBe(0);
  expect(next.instructionIds).toEqual([next.assignmentId]); expect(f.watched.at(-1)).toBe(next);
  expect([...f.tasks.values()].filter((task) => task.state === "running")).toHaveLength(7);
  expect(f.tabs.map((tab) => tab.pane_count)).toEqual([4, 3]);
  const start = f.calls.filter((args) => args[1] === "start").at(-1)!;
  expect(start[start.indexOf("--session") + 1]).toBe(next.sessionPath); expect(start).not.toContain("--session-id");
  expect(start[start.indexOf("--model") + 1]).toBe(previous.model); expect(start[start.indexOf("--thinking") + 1]).toBe("high");
  expect(start).toContain("--no-mcp");
  const prompts = f.calls.filter((args) => args[1] === "prompt"); expect(prompts).toHaveLength(7);
  expect(prompts.at(-1)![3]).toStartWith(`p3:routed-request ${next.assignmentId}\nExplicit follow-up only.\n`);
  expect(prompts.at(-1)![3]).not.toContain(previous.assignmentId!);
});

test("continuation still rejects overlapping owned paths above four active tasks", async () => {
  const f = fixture(); await f.fill(); const previous = await previousTask();
  previous.ownedPaths = [join(temp, "file-0.ts")]; const before = f.tasks.size;
  await expect(continueRoutedTask(f.deps, f.ctx, previous, "Explicit follow-up.")).rejects.toThrow("overlapping paths");
  expect(f.tasks.size).toBe(before); expect(f.calls.filter((args) => args[1] === "start")).toHaveLength(6);
});
