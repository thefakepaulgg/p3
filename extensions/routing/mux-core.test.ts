import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreRpcError, requestCore, resolveCoreSocketPath, setCoreTestTransportForTests } from "./core-socket.ts";
import { launchHerdrAgent } from "./herdr.ts";
import { routes } from "./policy.ts";
import { coreMux, normalizeCoreTerminal } from "./mux-core.ts";
import { detectMux, isReservedPane, mux, selfIdentity, setMuxForTests } from "./mux.ts";

const pi = {} as any;
type Call = { method: string; params: any };
let calls: Call[];
let terminals: Map<string, any>;
let temp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HERDR_ENV", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"];

const terminal = (address: string, patch: Record<string, unknown> = {}) => ({
  address, name: null, labels: {}, argv: [], cwd: "/", state: "live", status: null, turn: 0, parent: "t1", ...patch,
});

/** Minimal in-memory core: just the methods the backend uses. */
const installFakeCore = () => {
  let next = 7;
  const handler = async (method: string, params: any) => {
    calls.push({ method, params });
    const find = () => {
      const found = terminals.get(String(params.terminal));
      if (!found) throw new CoreRpcError("not_found", `no terminal ${params.terminal}`);
      return found;
    };
    switch (method) {
      case "terminal.run": {
        const created = terminal(`t${next++}`, { labels: params.labels, name: params.name, argv: params.argv, cwd: params.cwd });
        terminals.set(created.address, created);
        return created;
      }
      case "terminal.get": return find();
      case "terminal.list": return {
        terminals: [...terminals.values()].filter((t) => t.state === "live" && Object.entries(params.labels ?? {}).every(([key, value]) => t.labels[key] === value)), hidden_finished: 0, machines: [],
      };
      case "terminal.send": return { turn: find().turn, started: terminals.get(params.terminal).startsOnSend ?? true };
      case "terminal.keys": find(); return { turn: 0 };
      case "terminal.read": return { text: `screen of ${find().address}`, complete: true, how: "screen" };
      case "terminal.label": {
        const t = find();
        for (const [key, value] of Object.entries(params.labels as Record<string, string>)) { if (value === "") delete t.labels[key]; else t.labels[key] = value; }
        return t;
      }
      case "terminal.kill": { const t = find(); t.state = "finished"; t.reason = "killed"; t.status = null; return t; }
      case "terminal.rm": { const t = find(); if (t.state === "live") throw new CoreRpcError("live", "still live"); terminals.delete(t.address); return { removed: t.address }; }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  setCoreTestTransportForTests(handler);
  return handler;
};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  temp = mkdtempSync(join(tmpdir(), "mux-core-"));
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  process.env.HC_TERMINAL_ID = "t1";
  calls = [];
  terminals = new Map();
  installFakeCore();
  setMuxForTests(coreMux);
});
afterEach(() => {
  setCoreTestTransportForTests();
  setMuxForTests();
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(temp, { recursive: true, force: true });
});

describe("backend detection", () => {
  test("core wins whenever HC_TERMINAL_ID is set, even inside a Herdr TUI pane", () => {
    expect(detectMux({ HC_TERMINAL_ID: "t3", HERDR_ENV: "1", HERDR_PANE_ID: "w:p" })).toBe("core");
    expect(detectMux({ HC_TERMINAL_ID: "t3" })).toBe("core");
  });
  test("TUI needs HERDR_ENV and a pane; otherwise unmanaged", () => {
    expect(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w:p" })).toBe("tui");
    expect(detectMux({ HERDR_ENV: "1" })).toBeUndefined();
    expect(detectMux({})).toBeUndefined();
  });
  test("core identity is the terminal id and carries no workspace or tab", () => {
    expect(selfIdentity({ HC_TERMINAL_ID: "t3", HERDR_PANE_ID: "w:p", HERDR_WORKSPACE_ID: "w" })).toEqual({ backend: "core", id: "t3", role: undefined });
  });
  test("without an override HC_TERMINAL_ID selects the core backend", () => {
    setMuxForTests();
    process.env.HC_TERMINAL_ID = "t9";
    expect(mux().backend).toBe("core");
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    expect(mux().backend).toBe("tui");
  });
});

describe("core socket transport", () => {
  test("resolves HC_TERMINAL_SOCKET, then HC_SOCKET, then the per-user default", () => {
    expect(resolveCoreSocketPath({ HC_TERMINAL_SOCKET: "/a.sock", HC_SOCKET: "/b.sock" })).toBe("/a.sock");
    expect(resolveCoreSocketPath({ HC_SOCKET: "/b.sock" })).toBe("/b.sock");
    expect(resolveCoreSocketPath({})).toBe(`/run/user/${process.getuid!()}/herdr-core/default.sock`);
  });

  test("speaks line-delimited JSON-RPC 2.0 and surfaces error kinds", async () => {
    setCoreTestTransportForTests();
    const socketPath = join(temp, "core.sock");
    const requests: any[] = [];
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        if (!buffered.includes("\n")) return;
        const request = JSON.parse(buffered.split("\n")[0]);
        requests.push(request);
        const reply = request.method === "terminal.get"
          ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "no terminal t9", data: { kind: "not_found" } } }
          : { jsonrpc: "2.0", id: request.id, result: { echoed: request.params } };
        socket.write(`${JSON.stringify(reply)}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.HC_TERMINAL_SOCKET = socketPath;
    try {
      expect(await requestCore("terminal.list", { all: true })).toEqual({ echoed: { all: true } });
      expect(requests[0]).toMatchObject({ jsonrpc: "2.0", method: "terminal.list", params: { all: true } });
      const failure = await requestCore("terminal.get", { terminal: "t9" }).catch((error) => error);
      expect(failure).toBeInstanceOf(CoreRpcError);
      expect(failure.kind).toBe("not_found");
      expect(failure.message).toContain("no terminal t9");
    } finally { server.close(); }
  });
});

describe("core mux operations", () => {
  test("maps OSC 7501 status and labels to a neutral agent; readiness needs a status and the session label", async () => {
    terminals.set("t7", terminal("t7", { labels: { "p3.handle": "h" } }));
    expect(await coreMux.getAgent(pi, "t7")).toMatchObject({ id: "t7", paneId: "t7", terminalId: "t7", kind: "pi", status: "unknown", launchPending: true, interactiveReady: false });
    terminals.get("t7").status = { state: "idle" };
    expect((await coreMux.getAgent(pi, "t7"))!.launchPending).toBe(true);
    terminals.get("t7").labels["p3.session"] = "/s/session.jsonl";
    expect(await coreMux.getAgent(pi, "t7")).toMatchObject({ status: "idle", sessionPath: "/s/session.jsonl", launchPending: false, interactiveReady: true });
    terminals.get("t7").status = { state: "working" };
    expect((await coreMux.getAgent(pi, "t7"))!.status).toBe("working");
  });

  test("a terminal that is missing or finished is agent_not_found", async () => {
    await expect(coreMux.getAgent(pi, "t99")).rejects.toThrow(/agent_not_found/);
    terminals.set("t7", terminal("t7", { state: "finished", reason: "exited", exit_code: 0 }));
    await expect(coreMux.getAgent(pi, "t7")).rejects.toThrow(/agent_not_found.*finished/);
    expect(await coreMux.listAgents(pi)).toEqual([]);
  });

  test("prompt sends without a caller (core would tag the text with <hc from>); awaitStart reports agent_prompt_stalled when core says it did not start", async () => {
    terminals.set("t7", terminal("t7"));
    await coreMux.prompt(pi, "t7", "hello");
    expect(calls.at(-1)).toEqual({ method: "terminal.send", params: { terminal: "t7", text: "hello" } });
    await coreMux.prompt(pi, "t7", "hello", { awaitStart: true });
    terminals.get("t7").startsOnSend = false;
    await expect(coreMux.prompt(pi, "t7", "again", { awaitStart: true })).rejects.toThrow(/agent_prompt_stalled/);
    await coreMux.prompt(pi, "t7", "steer");
  });

  test("keys, read and wait go through terminal.keys / terminal.read / terminal.get", async () => {
    terminals.set("t7", terminal("t7", { status: { state: "idle" } }));
    await coreMux.sendKeys(pi, "t7", ["esc"]);
    expect(calls.at(-1)).toEqual({ method: "terminal.keys", params: { terminal: "t7", keys: ["esc"] } });
    expect(await coreMux.read(pi, "t7", 20)).toBe("screen of t7");
    expect(calls.at(-1)!.params).toEqual({ terminal: "t7", lines: 20 });
    await coreMux.wait(pi, "t7", ["idle"], 1000);
    await expect(coreMux.wait(pi, "t7", ["working"], 300)).rejects.toThrow(/agent_wait_timeout/);
  });

  test("closing a worker kills then removes its terminal; focus is a no-op note", async () => {
    terminals.set("t7", terminal("t7"));
    expect(await coreMux.focusPane(pi, "t7")).toMatch(/Herdr App sidebar/);
    expect(calls.some((call) => call.method.includes("focus"))).toBe(false);
    expect(await coreMux.listPanes(pi)).toEqual([{ paneId: "t7" }]);
    await coreMux.closePane(pi, "t7");
    expect(calls.map((call) => call.method).slice(-2)).toEqual(["terminal.kill", "terminal.rm"]);
    expect(terminals.size).toBe(0);
  });

  test("session and metadata are published as labels; the same session is not re-sent", async () => {
    terminals.set("t7", terminal("t7"));
    await coreMux.reportSession(pi, "t7", "/s/a.jsonl", 1, "startup");
    await coreMux.reportSession(pi, "t7", "/s/a.jsonl", 2);
    expect(calls.filter((call) => call.method === "terminal.label")).toHaveLength(1);
    expect(terminals.get("t7").labels["p3.session"]).toBe("/s/a.jsonl");
    await coreMux.reportMetadata(pi, "t7", "pi-routing:delegation", { subagents: "2 subagents active" });
    expect(terminals.get("t7").labels["p3.subagents"]).toBe("2 subagents active");
    await coreMux.reportMetadata(pi, "t7", "pi-routing:delegation", { subagents: null });
    expect(terminals.get("t7").labels["p3.subagents"]).toBeUndefined();
  });

  test("a terminal's space and tab labels are its workspace and tab", () => {
    expect(normalizeCoreTerminal(terminal("t4", { labels: { "herdr.space": "sp", "herdr.tab": "tb", "p3.session": "/s" }, status: { state: "idle" } }))).toMatchObject({ workspaceId: "sp", tabId: "tb", kind: "pi" });
    expect(normalizeCoreTerminal(terminal("t5")).workspaceId).toBeUndefined();
  });
});

describe("peer agent placement on core", () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  const gitPi = { exec: async (_command: string, args: string[]) => { const [, cwd, ...rest] = args; return git(cwd, ...rest); } } as any;
  let repo: string;
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    repo = join(temp, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    home = join(temp, "home");
    mkdirSync(home);
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });

  test("createTab reserves a placement that startAgent turns into a labeled, detached terminal", async () => {
    process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "w:p";
    const placed = await coreMux.createTab(pi, { workspaceId: "sp-1", cwd: "/repo", label: "Attached", focus: true, env: { PI_ROUTED_ATTACHMENT_ID: "att" }, labels: { "p3.attachment": "att" } });
    expect(isReservedPane(placed.paneId)).toBe(true);
    expect(calls).toEqual([]);
    const started = await coreMux.startAgent(pi, "a-one", placed.paneId!, ["--session", "/s.jsonl"]);
    expect(started).toMatchObject({ id: "t7", paneId: "t7", workspaceId: "sp-1", tabId: placed.tabId });
    const run = calls.find((call) => call.method === "terminal.run")!.params;
    expect(run).toMatchObject({ cwd: "/repo", name: "a-one", caller: "t1", outlive_parent: true, no_notify: true });
    expect(run.argv.slice(1)).toEqual(["--session", "/s.jsonl"]);
    expect(run.argv[0]).toMatch(/(^|\/)pi$/);
    expect(run.env).toEqual({ PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_ROUTED_ATTACHMENT_ID: "att" });
    expect(run.labels).toEqual({ "p3.attachment": "att", "p3.handle": "a-one", "p3.tab": placed.tabId, "herdr.space": "sp-1", "herdr.tab": placed.tabId });
    await expect(coreMux.startAgent(pi, "again", placed.paneId!, [])).rejects.toThrow(/no pane/);
  });

  test("without a space the terminal gets no App placement labels", async () => {
    const placed = await coreMux.createTab(pi, { workspaceId: "", cwd: "/repo", label: "Attached", focus: true });
    await coreMux.startAgent(pi, "a-two", placed.paneId!, []);
    const labels = calls.find((call) => call.method === "terminal.run")!.params.labels;
    expect(labels["herdr.space"]).toBeUndefined();
    expect(labels["herdr.tab"]).toBeUndefined();
    expect(labels["p3.tab"]).toBe(placed.tabId);
  });

  test("closeTab ends and removes every terminal of that tab, listPanes reports tabs per space", async () => {
    const placed = await coreMux.createTab(pi, { workspaceId: "sp-1", cwd: "/repo", label: "x", focus: false });
    const agent = await coreMux.startAgent(pi, "a-three", placed.paneId!, []);
    terminals.set("t99", terminal("t99", { labels: { "herdr.space": "other" } }));
    expect(await coreMux.listPanes(pi, "sp-1")).toEqual([{ paneId: agent!.paneId!, tabId: placed.tabId }]);
    await coreMux.closeTab(pi, placed.tabId!);
    expect(terminals.has(agent!.paneId!)).toBe(false);
    expect(terminals.has("t99")).toBe(true);
  });

  test("worktreeList finds the main checkout from a linked worktree", async () => {
    expect((await coreMux.worktreeList(gitPi, { cwd: repo })).repoRoot).toBe(repo);
    const linked = join(temp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked);
    expect((await coreMux.worktreeList(gitPi, { cwd: linked })).repoRoot).toBe(repo);
  });

  test("worktreeOpen create uses the App's ~/.herdr/worktrees/<repo>/<branch> path and a new space", async () => {
    const placement = await coreMux.worktreeOpen(gitPi, "create", { cwd: repo, branch: "Feature/Login-Fix" });
    const expected = join(home, ".herdr", "worktrees", "repo", "feature-login-fix");
    expect(placement).toMatchObject({ worktreePath: realpathSync(expected), alreadyOpen: false });
    expect(placement.workspaceId).toMatch(/^p3-[0-9a-f]{12}$/);
    expect(git(expected, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe("Feature/Login-Fix");
    expect(isReservedPane(placement.rootPaneId)).toBe(true);
    await expect(coreMux.worktreeOpen(gitPi, "create", { cwd: repo, branch: "Feature/Login-Fix" })).rejects.toThrow(/already checked out/);
    const agent = await coreMux.startAgent(pi, "i-1", placement.rootPaneId, []);
    const labels = calls.find((call) => call.method === "terminal.run")!.params.labels;
    expect(labels).toMatchObject({ "herdr.space": placement.workspaceId, "p3.branch": "Feature/Login-Fix", "p3.worktree": placement.worktreePath, "p3.handle": "i-1" });
    expect(agent?.workspaceId).toBe(placement.workspaceId);
  });

  test("open joins the space of a live terminal serving the checkout, or the recorded one", async () => {
    const created = await coreMux.worktreeOpen(gitPi, "create", { cwd: repo, branch: "work" });
    terminals.set("t40", terminal("t40", { labels: { "herdr.space": "live-space", "herdr.tab": "x" }, cwd: created.worktreePath }));
    const joined = await coreMux.worktreeOpen(gitPi, "open", { cwd: repo, branch: "work" });
    expect(joined).toMatchObject({ workspaceId: "live-space", alreadyOpen: true, rootPaneId: "" });
    const recorded = await coreMux.worktreeOpen(gitPi, "open", { cwd: created.worktreePath, branch: "work", reuseSpace: "old-space" });
    expect(recorded).toMatchObject({ workspaceId: "old-space", alreadyOpen: false, worktreePath: created.worktreePath });
    await expect(coreMux.worktreeOpen(gitPi, "open", { cwd: repo, branch: "missing" })).rejects.toThrow(/git worktree add failed/);
  });
});

describe("routed worker launch on core", () => {
  const assignment = randomUUID();
  const sessionFile = () => {
    const path = join(temp, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", id: assignment })}\n`);
    return path;
  };

  test("launches a child terminal with the decided run parameters and no HERDR_* environment", async () => {
    process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "w:p"; // must never leak into the worker
    const progress = { stage: "", attempted: false, started: false, retryAttempted: false };
    const allocated: any[] = [];
    const worker = await coreMux.launchWorker(pi, {
      name: "r-task-abc", cwd: "/repo", args: ["--name", "task"], manifestPath: "/m.json", background: true, assignmentId: "a-1", readonly: true,
      handle: "sa-1", sessionPath: "/s/saved.jsonl", onAllocated: (w) => allocated.push(w),
    }, progress);
    expect(worker).toEqual({ agent: "t7", paneId: "t7", terminalId: "t7" });
    expect(allocated).toEqual([worker]);
    expect(progress).toMatchObject({ attempted: true, started: true, worker });
    const run = calls.find((call) => call.method === "terminal.run")!.params;
    expect(run.argv[0]).toMatch(/(^|\/)pi$/); // resolved through PATH: a core terminal's own PATH may lack pi
    expect(run).toEqual({
      argv: [run.argv[0], "--name", "task"], cwd: "/repo", name: "r-task-abc", caller: "t1", outlive_parent: true, no_notify: true,
      env: { PI_ROUTING_MANIFEST: "/m.json", PI_SUBAGENT_MODE: "background", PI_ROUTED_ASSIGNMENT_ID: "a-1", PI_ROUTED_READONLY: "1", PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR },
      labels: { "p3.handle": "sa-1", "p3.assignment": "a-1", "p3.session": "/s/saved.jsonl" },
    });
    expect(Object.keys(run.env).some((key) => key.startsWith("HERDR_"))).toBe(false);
    expect(run.labels["herdr.space"]).toBeUndefined();
    expect(run.labels["herdr.tab"]).toBeUndefined();
  });

  test("a failed run is reported before any identity exists", async () => {
    setCoreTestTransportForTests(async () => { throw new CoreRpcError("spawn_failed", "no pi"); });
    const progress = { stage: "", attempted: false, started: false, retryAttempted: false };
    await expect(coreMux.launchWorker(pi, { name: "n", cwd: "/", args: [] }, progress)).rejects.toThrow(/spawn_failed/);
    expect(progress.worker).toBeUndefined();
    expect(progress.started).toBe(false);
  });

  test("launchHerdrAgent waits for the first status and session label, then submits the task", async () => {
    const path = sessionFile();
    const base = installFakeCore();
    let polls = 0;
    // The worker reports status first, then publishes its session a poll later.
    setCoreTestTransportForTests(async (method, params, timeout) => {
      if (method === "terminal.get" && params.terminal === "t7") {
        polls += 1;
        const t = terminals.get("t7");
        if (polls === 2) t.status = { state: "idle" };
        if (polls === 3) t.labels["p3.session"] = path;
      }
      return base(method, params, timeout);
    });
    const events: string[] = [];
    const launch = await launchHerdrAgent(pi, "Inspect only", "Core task", "luna", routes.luna, "/repo", 5000, "/m.json", [], false, {
      assignmentId: assignment, handle: "sa-9", onAllocated: (l) => events.push(`allocated:${l.paneId}`), onStarted: (l) => events.push(`started:${l.terminalId}`),
    });
    expect(launch).toMatchObject({ agent: "t7", paneId: "t7", tabId: undefined, terminalId: "t7", sessionPath: path, sessionId: assignment });
    expect(events).toEqual(["allocated:t7", "started:t7"]);
    const send = calls.find((call) => call.method === "terminal.send")!.params;
    expect(send.terminal).toBe("t7");
    expect(send.text).toContain(`p3:routed-request ${assignment}`);
    expect(send.text).toContain("Inspect only");
    expect(calls.findIndex((call) => call.method === "terminal.send")).toBeGreaterThan(calls.findIndex((call) => call.method === "terminal.run"));
  });

  test("a worker that exits during startup fails the launch without a rollback guess", async () => {
    const base = installFakeCore();
    setCoreTestTransportForTests(async (method, params, timeout) => {
      const result = await base(method, params, timeout);
      if (method === "terminal.run") { const t = terminals.get(result.address); t.state = "finished"; t.reason = "exited"; }
      return result;
    });
    const error: any = await launchHerdrAgent(pi, "Inspect only", "Core task", "luna", routes.luna, "/repo", 2000, undefined, [], false, { assignmentId: randomUUID() }).catch((e) => e);
    expect(String(error.message)).toMatch(/agent_not_found.*finished/);
    expect(calls.some((call) => call.method === "terminal.kill")).toBe(false);
  });
});
