import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreRpcError, setCoreTestTransportForTests } from "./core-socket.ts";
import { registerIndependentAgentTools } from "./independent.ts";
import { setMuxForTests } from "./mux.ts";
import { routes } from "./policy.ts";

// workspace_agent / workspace_agent_control / message_agent against an in-memory Herdr Core.

type Call = { method: string; params: any };
const ENV_KEYS = ["HC_TERMINAL_ID", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "PI_CODING_AGENT_DIR", "HOME"];
const saved: Record<string, string | undefined> = {};
let temp: string;
let repo: string;
let calls: Call[];
let terminals: Map<string, any>;
let tools: Map<string, any>;
let handlers: Map<string, (...args: any[]) => any>;

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

const terminal = (address: string, patch: Record<string, unknown> = {}) => ({
  address, name: null, labels: {}, argv: [], cwd: "/", state: "live", status: null, turn: 0, parent: null, ...patch,
});

/** Core where a started `pi` reports idle and publishes the session named by `--session-id` / `--session` at once. */
const installFakeCore = () => {
  let next = 20;
  setCoreTestTransportForTests(async (method, params) => {
    calls.push({ method, params });
    const find = () => {
      const found = terminals.get(String(params.terminal)) ?? [...terminals.values()].find((t) => t.name === params.terminal);
      if (!found) throw new CoreRpcError("not_found", `no terminal ${params.terminal}`);
      return found;
    };
    switch (method) {
      case "terminal.run": {
        const args: string[] = params.argv.slice(1);
        const sessionId = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : undefined;
        const sessionPath = args.includes("--session") ? args[args.indexOf("--session") + 1] : join(temp, `${sessionId}.jsonl`);
        if (sessionId) writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
        const created = terminal(`t${next++}`, { labels: { ...params.labels, "p3.session": sessionPath }, name: params.name, argv: params.argv, cwd: params.cwd, parent: params.caller, status: { state: "idle" } });
        terminals.set(created.address, created);
        return created;
      }
      case "terminal.get": return find();
      case "terminal.list": return {
        terminals: [...terminals.values()].filter((t) => t.state === "live" && Object.entries(params.labels ?? {}).every(([k, v]) => t.labels[k] === v)), hidden_finished: 0, machines: [],
      };
      case "terminal.send": find(); return { turn: 1, started: true };
      case "terminal.keys": find(); return { turn: 1 };
      case "terminal.kill": { const t = find(); t.state = "finished"; t.reason = "killed"; return t; }
      case "terminal.rm": { const t = find(); terminals.delete(t.address); return { removed: t.address }; }
      default: throw new Error(`unexpected ${method}`);
    }
  });
};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) delete process.env[key];
  temp = realpathSync(mkdtempSync(join(tmpdir(), "independent-core-")));
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  process.env.HOME = join(temp, "home");
  process.env.HC_TERMINAL_ID = "t1";
  mkdirSync(process.env.HOME);
  repo = join(temp, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  calls = [];
  // The primary: an App-placed terminal whose Pi published its session.
  terminals = new Map([["t1", terminal("t1", { name: "primary", cwd: repo, status: { state: "working" }, labels: { "herdr.space": "prim-space", "herdr.tab": "prim-tab", "p3.session": join(temp, "primary.jsonl") } })]]);
  installFakeCore();
  setMuxForTests();
  tools = new Map();
  handlers = new Map();
  registerIndependentAgentTools({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    exec: async (_command: string, args: string[]) => { const [, cwd, ...rest] = args; return git(cwd, ...rest); },
    getThinkingLevel: () => "off",
  } as any, (_ctx, requested) => {
    if (requested !== "opus") throw new Error(`Unexpected test model: ${requested}`);
    return routes.opus;
  });
});
afterEach(() => {
  setCoreTestTransportForTests();
  setMuxForTests();
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(temp, { recursive: true, force: true });
});

const run = (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, { cwd: repo, model: undefined });
const text = (result: any) => result.content[0].text as string;

describe("workspace agents on Herdr Core", () => {
  test("explicit model selection reaches the Core peer launch", async () => {
    const result = await run("workspace_agent", { action: "create", branch: "model-peer", task: "Implement task", description: "Model peer", model: "opus" });
    expect(result.isError).not.toBe(true);
    const args = calls.find((call) => call.method === "terminal.run")!.params.argv;
    expect(args[args.indexOf("--model") + 1]).toBe(`${routes.opus.provider}/${routes.opus.model}`);
    expect(args[args.indexOf("--thinking") + 1]).toBe(routes.opus.thinking);
  });

  test("create places a worktree peer in its own space, detached from this session, and sends the task after readiness", async () => {
    const result = await run("workspace_agent", { action: "create", branch: "peer-one", description: "peer one", task: "Do the thing" });
    expect(text(result)).toContain("Started independent agent");
    const runCall = calls.find((call) => call.method === "terminal.run")!.params;
    const worktree = realpathSync(join(process.env.HOME!, ".herdr", "worktrees", "repo", "peer-one"));
    expect(runCall).toMatchObject({ cwd: worktree, no_parent: true, outlive_parent: true, no_notify: true });
    expect(runCall.caller).toBeUndefined();
    expect(runCall.labels["herdr.space"]).toMatch(/^p3-[0-9a-f]{12}$/);
    expect(runCall.labels).toMatchObject({ "herdr.tab": runCall.labels["p3.tab"], "p3.branch": "peer-one", "p3.worktree": worktree });
    expect(Object.keys(runCall.env).filter((key) => key.startsWith("HERDR_"))).toEqual([]);
    expect(runCall.env.PI_CODING_AGENT_DIR).toBe(process.env.PI_CODING_AGENT_DIR);
    expect(runCall.argv).toEqual(expect.arrayContaining(["--session-id", "--name", "peer one"]));
    const send = calls.find((call) => call.method === "terminal.send")!.params;
    expect(send.terminal).toBe(runCall.name);
    expect(send.caller).toBeUndefined();
    expect(send.text).toContain("Do the thing");
    expect(send.text).toContain("launching primary for this assignment");
    expect(calls.findIndex((call) => call.method === "terminal.send")).toBeGreaterThan(calls.findIndex((call) => call.method === "terminal.run"));
    expect(result.details.work.executor).toMatchObject({ pane: result.details.paneId, terminal: result.details.paneId, workspace: runCall.labels["herdr.space"] });
    expect(git(worktree, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe("peer-one");
  });

  test("status, list and pause use terminal state; resume of a live executor sends the explicit instruction once", async () => {
    const created = await run("workspace_agent", { action: "create", branch: "peer-two", description: "peer two", task: "Task" });
    const pane = created.details.paneId as string;
    const status = await run("workspace_agent_control", { action: "status", branch: "peer-two" });
    expect(status.details.runtime).toBe("idle");
    expect(text(await run("workspace_agent_control", { action: "list" }))).toContain("peer-two [open] — peer two");
    calls.length = 0;
    await run("workspace_agent_control", { action: "pause", branch: "peer-two" });
    expect(calls.find((call) => call.method === "terminal.keys")!.params).toEqual({ terminal: pane, keys: ["esc"] });
    await run("workspace_agent_control", { action: "resume", branch: "peer-two", message: "Continue with step 2" });
    const sends = calls.filter((call) => call.method === "terminal.send");
    expect(sends).toHaveLength(1);
    expect(sends[0].params.text).toBe("Continue with step 2");
  });

  test("message_agent passes the identity and workspace checks on core (same space is refused)", async () => {
    const created = await run("workspace_agent", { action: "create", branch: "peer-three", description: "peer three", task: "Task" });
    // The peer has no inbox in this test; failing at delivery proves the checks before it passed.
    const failed = await run("message_agent", { target: created.details.paneId, text: "hello" });
    expect(failed.details.stage ?? failed.details.error?.stage ?? JSON.stringify(failed.details)).toContain("message_submission");
    terminals.get(created.details.paneId).labels["herdr.space"] = "prim-space";
    const refused = await run("message_agent", { target: created.details.paneId, text: "hello" });
    expect(JSON.stringify(refused)).toContain("another workspace");
  });

  test("a missing executor resumes only on an interactive turn, into its recorded space, continuing the saved session", async () => {
    const created = await run("workspace_agent", { action: "create", branch: "peer-four", description: "peer four", task: "Original task" });
    const old = created.details.work.executor;
    terminals.delete(old.pane);
    const refused = await run("workspace_agent_control", { action: "resume", branch: "peer-four", message: "Continue" });
    expect(JSON.stringify(refused)).toContain("fresh interactive user request");
    handlers.get("input")!({ source: "interactive", text: "please resume" });
    handlers.get("before_agent_start")!({ prompt: "please resume" });
    calls.length = 0;
    const resumed = await run("workspace_agent_control", { action: "resume", branch: "peer-four", message: "Continue" });
    expect(text(resumed)).toContain("Resumed peer-four");
    const runCall = calls.find((call) => call.method === "terminal.run")!.params;
    expect(runCall.argv.slice(-4, -2)).toEqual(["--session", old.sessionPath]);
    expect(runCall.labels["herdr.space"]).toBe(old.workspace);
    expect(runCall.cwd).toBe(created.details.worktree);
    const sends = calls.filter((call) => call.method === "terminal.send");
    expect(sends.map((call) => call.params.text)).toEqual(["Continue"]);
    expect(resumed.details.work.executor).toMatchObject({ workspace: old.workspace, sessionId: old.sessionId });
    expect(resumed.details.work.executor.pane).not.toBe(old.pane);
  });
});
