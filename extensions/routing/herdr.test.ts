import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { buildRoutedWorkerPiArgs, herdrSocketRequestForArgs, launchHerdrAgent, parseJson, readHerdrResult, requestHerdrSocket, resolveHerdrSocketPath, ROUTED_TAB_MAX_PANES, setHerdrTestTransportForTests, shouldCloseCompletedPane, watchHerdrTask } from "./herdr.ts";
import { routes, type Route } from "./policy.ts";
import { COMPLETION_KIND, NOTIFICATION_LIMIT, type TaskHandle } from "./state.ts";

// Existing orchestration tests use deterministic in-memory transport responses. Dedicated
// tests below exercise the production Unix socket transport directly.
setHerdrTestTransportForTests(async (pi: any, args, timeout) => {
  const result = await pi.exec("herdr", args, { timeout });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "test Herdr request failed");
  return result.stdout.trim();
});

let temp: string | undefined;
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = undefined; });

describe("completed pane retention", () => {
  test("keeps by default", () => expect(shouldCloseCompletedPane()).toBe(false));
  test("explicit close removes pane", () => expect(shouldCloseCompletedPane("close")).toBe(true));
});

describe("Herdr response parsing", () => {
  test("parses success envelope", () => expect(parseJson('{"result":{"agent":{"agent_status":"idle"}}}', "test").result.agent.agent_status).toBe("idle"));
  test("rejects invalid JSON", () => expect(() => parseJson("not json", "test")).toThrow("invalid JSON"));
});

describe("routed worker Pi arguments", () => {
  const agentDir = "/tmp/pi-agent";
  const parentNavigation = fileURLToPath(new URL("./parent-navigation.ts", import.meta.url));
  const route = (provider: string, model: string, thinking: Route["thinking"] = "medium") => ({ provider, model, thinking } as Route);
  const withAgentDir = (check: () => void) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try { check(); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  };

  test("builds the exact default worker arguments without root model routing", () => withAgentDir(() => {
    const args = buildRoutedWorkerPiArgs("Default task", route("openai-codex", "gpt-6-astra"));
    expect(args).toEqual([
      "--no-extensions", "-e", `${agentDir}/extensions/herdr-agent-state.ts`,
      "-e", parentNavigation,
      "--model", "openai-codex/gpt-6-astra", "--thinking", "medium", "--name", "Default task",
    ]);
    expect(args).not.toContain(fileURLToPath(new URL("../model-routing.ts", import.meta.url)));
  }));

  test("builds the exact memory worker arguments", () => withAgentDir(() => {
    expect(buildRoutedWorkerPiArgs("Memory task", route("openai-codex", "gpt-6-astra"), ["memory"])).toEqual([
      "--no-extensions", "-e", `${agentDir}/extensions/herdr-agent-state.ts`,
      "-e", parentNavigation,
      "-e", `${agentDir}/npm/node_modules/pi-hermes-memory/src/index.ts`,
      "--model", "openai-codex/gpt-6-astra", "--thinking", "medium", "--name", "Memory task",
    ]);
  }));

  test("builds the exact Fable worker arguments", () => withAgentDir(() => {
    expect(buildRoutedWorkerPiArgs("Fable task", route("anthropic", "claude-fable-5-1"))).toEqual([
      "--no-extensions", "-e", `${agentDir}/extensions/herdr-agent-state.ts`,
      "-e", parentNavigation,
      "-e", fileURLToPath(new URL("../model-style.ts", import.meta.url)),
      "--model", "anthropic/claude-fable-5-1", "--thinking", "medium", "--name", "Fable task",
    ]);
  }));

  test("builds the exact Ollama Cloud worker arguments", () => withAgentDir(() => {
    expect(buildRoutedWorkerPiArgs("Cloud task", route("ollama-cloud", "qwen3"))).toEqual([
      "--no-extensions", "-e", `${agentDir}/extensions/herdr-agent-state.ts`,
      "-e", parentNavigation,
      "-e", `${agentDir}/npm/node_modules/pi-ollama-cloud/index.ts`,
      "--model", "ollama-cloud/qwen3", "--thinking", "medium", "--name", "Cloud task",
    ]);
  }));
});

describe("Herdr Unix socket transport", () => {
  const withSocket = async (respond: (request: any) => any | undefined, run: (path: string) => Promise<void>) => {
    temp = mkdtempSync(join(tmpdir(), "routing-herdr-socket-"));
    const path = join(temp, "herdr.sock");
    const server = createServer((connection) => {
      let input = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline));
        const response = respond(request);
        if (response !== undefined) connection.end(`${JSON.stringify(response)}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
    try { await run(path); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  };

  test("sends newline-delimited requests and matches response ids", async () => {
    await withSocket(
      (request) => ({ id: request.id, result: { type: "pong", version: "0.8.0", protocol: 19 } }),
      async (path) => {
        const response = await requestHerdrSocket("ping", {}, 1000, path);
        expect(response.result.protocol).toBe(19);
      },
    );
  });

  test("surfaces structured Herdr errors", async () => {
    await withSocket(
      (request) => ({ id: request.id, error: { code: "agent_prompt_stalled", message: "prompt did not start" } }),
      async (path) => {
        await expect(requestHerdrSocket("agent.prompt", { target: "worker", text: "go" }, 1000, path)).rejects.toThrow("agent_prompt_stalled");
      },
    );
  });

  test("bounds silent socket requests", async () => {
    await withSocket(
      () => undefined,
      async (path) => {
        await expect(requestHerdrSocket("agent.get", { target: "worker" }, 30, path)).rejects.toThrow("herdr_socket_timeout");
      },
    );
  });

  test("prefers the socket path inherited from Herdr", () => {
    const previous = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = "/tmp/inherited-herdr.sock";
    try { expect(resolveHerdrSocketPath()).toBe("/tmp/inherited-herdr.sock"); }
    finally { if (previous === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = previous; }
  });

  test("maps every routed operation to its protocol-19 request shape", () => {
    const cases: Array<[string[], string, Record<string, unknown>]> = [
      [["tab", "list", "--workspace", "w1"], "tab.list", { workspace_id: "w1" }],
      [["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "Agents", "--env", "A=B", "--no-focus"], "tab.create", { workspace_id: "w1", cwd: "/repo", focus: false, label: "Agents", env: { A: "B" } }],
      [["tab", "close", "w1:t2"], "tab.close", { tab_id: "w1:t2" }],
      [["pane", "list", "--workspace", "w1"], "pane.list", { workspace_id: "w1" }],
      [["pane", "layout", "--pane", "w1:p2"], "pane.layout", { pane_id: "w1:p2" }],
      [["pane", "focus", "w1:p2"], "pane.focus", { pane_id: "w1:p2" }],
      [["pane", "split", "--pane", "w1:p2", "--direction", "right", "--cwd", "/repo", "--env", "A=B", "--no-focus"], "pane.split", { target_pane_id: "w1:p2", direction: "right", cwd: "/repo", focus: false, env: { A: "B" } }],
      [["pane", "close", "w1:p2"], "pane.close", { pane_id: "w1:p2" }],
      [["pane", "report-metadata", "w1:p1", "--source", "pi-routing:delegation", "--token", "routed=1 routed active"], "pane.report_metadata", { pane_id: "w1:p1", source: "pi-routing:delegation", clear_display_agent: false, tokens: { routed: "1 routed active" } }],
      [["pane", "report-metadata", "w1:p1", "--source", "pi-routing:delegation", "--clear-token", "routed"], "pane.report_metadata", { pane_id: "w1:p1", source: "pi-routing:delegation", clear_display_agent: false, tokens: { routed: null } }],
      [["agent", "get", "worker"], "agent.get", { target: "worker" }],
      [["agent", "focus", "worker"], "agent.focus", { target: "worker" }],
      [["agent", "read", "worker", "--source", "recent-unwrapped", "--lines", "120"], "agent.read", { target: "worker", source: "recent_unwrapped", lines: 120, format: "text", strip_ansi: true }],
      [["agent", "send-keys", "worker", "enter"], "agent.send_keys", { target: "worker", keys: ["enter"] }],
      [["agent", "wait", "worker", "--until", "working", "--until", "done", "--timeout", "5000"], "agent.wait", { target: "worker", until: ["working", "done"], timeout_ms: 5000 }],
      [["agent", "prompt", "worker", "do it", "--wait", "--until", "working", "--until", "done", "--timeout", "7000"], "agent.prompt", { target: "worker", text: "do it", wait: { until: ["working", "done"], timeout_ms: 7000 } }],
      [["agent", "start", "worker", "--kind", "pi", "--pane", "w1:p2", "--timeout", "30000", "--", "--model", "openai/gpt"], "agent.start", { name: "worker", kind: "pi", pane_id: "w1:p2", timeout_ms: 30000, args: ["--model", "openai/gpt"] }],
    ];
    for (const [args, method, params] of cases) {
      const request = herdrSocketRequestForArgs(args);
      expect(request.method).toBe(method);
      expect(JSON.parse(JSON.stringify(request.params))).toEqual(params);
    }
  });
});

describe("watcher notifications", () => {
  const herdrTask = (patch: Partial<TaskHandle> = {}): TaskHandle => ({
    handle: "rt-watch", route: "luna", routeExplicit: false, target: "herdr",
    model: "openai-codex/gpt-5.6-luna", thinking: "high", label: "Watched task", state: "running",
    startedAt: Date.now(), agentName: "r-watch", paneId: "w1:p2", paneRetention: "keep",
    transitions: 0, notifiedStates: [], ...patch,
  });

  const sessionWith = (text: string) => {
    temp = mkdtempSync(join(tmpdir(), "routing-watch-"));
    const file = join(temp, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`);
    return file;
  };

  const drive = async (task: TaskHandle, status: string, sessionPath: string) => {
    const notifications: Array<{ kind: string; content: string }> = [];
    const calls: string[][] = [];
    const pi: any = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args.slice(0, 2).join(" ") === "agent get") {
          return { code: 0, stdout: JSON.stringify({ result: { agent: { agent_status: status, agent_session: { value: sessionPath } } } }), stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    };
    const watchers = new Map<string, AbortController>();
    watchHerdrTask({
      pi, task, watchers,
      update: (patch) => Object.assign(task, patch),
      persist: () => {},
      notify: (kind, content) => notifications.push({ kind, content }),
    });
    for (let tick = 0; tick < 5 && !notifications.length; tick += 1) await new Promise((done) => setTimeout(done, 40));
    watchers.get(task.handle)?.abort();
    return { notifications, calls };
  };

  test("delivers one bounded completion notification and stops watching", async () => {
    const task = herdrTask();
    const { notifications } = await drive(task, "idle", sessionWith("F".repeat(8000)));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.kind).toBe(COMPLETION_KIND);
    expect(notifications[0]!.content.length).toBeLessThanOrEqual(NOTIFICATION_LIMIT);
    expect(notifications[0]!.content).toContain("routed_task_control action=result handle=rt-watch");
    expect(task.state).toBe("completed");
    expect(task.result).toBe("F".repeat(8000));
    expect(task.resultChars).toBe(8000);
    await new Promise((done) => setTimeout(done, 60));
    expect(notifications).toHaveLength(1);
  });

  test("closes the pane before announcing completion when close was requested", async () => {
    const task = herdrTask({ paneRetention: "close" });
    const { notifications, calls } = await drive(task, "idle", sessionWith("done"));
    expect(calls.some((args) => args.join(" ") === "pane close w1:p2")).toBe(true);
    expect(task.paneClosedAt).toBeNumber();
    expect(notifications[0]!.content).toContain("Pane w1:p2 was closed");
  });

  test("blocked notifications carry an episode kind", async () => {
    const task = herdrTask();
    const { notifications } = await drive(task, "blocked", sessionWith("partial"));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.kind).toBe("blocked#1");
    expect(task.blockedEpisodes).toBe(1);
    expect(task.state).toBe("blocked");
  });

  test("does not abandon a stopped task when an in-flight poll observes a closed agent", async () => {
    const task = herdrTask();
    const notifications: Array<{ kind: string; content: string }> = [];
    let resolveAgentGet: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined;
    const pi: any = {
      exec: async (_command: string, args: string[]) => {
        if (args.slice(0, 2).join(" ") !== "agent get") {
          return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
        }
        return new Promise((resolve) => { resolveAgentGet = resolve; });
      },
    };
    const watchers = new Map<string, AbortController>();
    watchHerdrTask({
      pi, task, watchers,
      update: (patch) => Object.assign(task, patch),
      persist: () => {},
      notify: (kind, content) => notifications.push({ kind, content }),
    });
    for (let attempt = 0; attempt < 10 && !resolveAgentGet; attempt += 1) {
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(resolveAgentGet).toBeFunction();

    watchers.get(task.handle)?.abort();
    task.state = "stopped";
    resolveAgentGet!({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "agent_not_found", message: "agent disappeared" } }),
    });
    await new Promise((done) => setTimeout(done, 20));

    expect(task.state).toBe("stopped");
    expect(notifications).toHaveLength(0);
    expect(watchers.has(task.handle)).toBe(false);
  });
});

describe("Pi session result extraction", () => {
  test("returns last assistant text", () => {
    temp = mkdtempSync(join(tmpdir(), "routing-test-"));
    const file = join(temp, "session.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "next" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final result" }] } }),
      "",
    ].join("\n"));
    expect(readHerdrResult(file)).toBe("final result");
  });

  test("ignores incomplete tail", () => {
    temp = mkdtempSync(join(tmpdir(), "routing-test-"));
    const file = join(temp, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "safe" }] } })}\n{"broken"`);
    expect(readHerdrResult(file)).toBe("safe");
  });
});

const isolatedHerdrEnv = () => {
  const names = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "PI_ROUTED_ROOT_WORKSPACE_ID", "PI_ROUTED_ROOT_TAB_ID"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" });
  delete process.env.PI_ROUTED_ROOT_WORKSPACE_ID;
  delete process.env.PI_ROUTED_ROOT_TAB_ID;
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  };
};

const ok = (result: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const readyAgent = () => ok({ agent: { agent_status: "idle", interactive_ready: true } });

describe("routed agent tab isolation", () => {
  test("first routed agent creates a dedicated unfocused tab instead of splitting the root tab", async () => {
    const restore = isolatedHerdrEnv();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return readyAgent();
      return ok();
    } };
    try {
      const launched = await launchHerdrAgent(pi, "Inspect only", "Isolated task", "luna", routes.luna, "/repo");
      expect(launched.tabId).toBe("w1:t2");
      expect(launched.paneId).toBe("w1:p2");
      expect(calls.some((args) => args.slice(0, 2).join(" ") === "pane split")).toBe(false);
      const start = calls.find((args) => args.slice(0, 2).join(" ") === "agent start")!;
      expect(start).toEqual([
        "agent", "start", launched.agent, "--kind", "pi", "--pane", "w1:p2", "--timeout", "30000", "--",
        "--no-extensions", "-e", "/tmp/pi-agent/extensions/herdr-agent-state.ts",
        "-e", fileURLToPath(new URL("./parent-navigation.ts", import.meta.url)),
        "--model", `${routes.luna.provider}/${routes.luna.model}`, "--thinking", routes.luna.thinking, "--name", "Isolated task",
      ]);
      expect(start).not.toContain(fileURLToPath(new URL("../model-routing.ts", import.meta.url)));
      const create = calls.find((args) => args.slice(0, 2).join(" ") === "tab create")!;
      expect(create).toContain("Routed agents · t1");
      expect(create).toContain("PI_ROUTED_ROOT_WORKSPACE_ID=w1");
      expect(create).toContain("PI_ROUTED_ROOT_TAB_ID=w1:t1");
      expect(create).toContain("--no-focus");
      const prompt = calls.find((args) => args.slice(0, 2).join(" ") === "agent prompt")!;
      expect(prompt).toContain("--wait");
      expect(prompt).toContain("working");
      expect(prompt).toContain("7000");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      restore();
    }
  });

  test("waits for socket-started agents to become prompt-ready", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    let getCalls = 0;
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return ok({ agent: { agent_status: "unknown", launch_pending: true } });
      if (key === "agent get") {
        getCalls += 1;
        return getCalls === 1
          ? ok({ agent: { agent_status: "idle", launch_pending: true } })
          : ok({ agent: { agent_status: "idle", interactive_ready: true } });
      }
      return ok();
    } };
    try {
      await launchHerdrAgent(pi, "Inspect only", "Delayed startup", "luna", routes.luna, "/repo");
      expect(getCalls).toBe(2);
      const getIndex = calls.findIndex((args) => args.slice(0, 2).join(" ") === "agent get");
      const promptIndex = calls.findIndex((args) => args.slice(0, 2).join(" ") === "agent prompt");
      expect(getIndex).toBeGreaterThan(-1);
      expect(promptIndex).toBeGreaterThan(getIndex);
    } finally { restore(); }
  });

  test("checks readiness when agent.start omits result.agent", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return ok();
      if (key === "agent get") return readyAgent();
      return ok();
    } };
    try {
      await launchHerdrAgent(pi, "Inspect only", "Missing start agent", "luna", routes.luna, "/repo");
      expect(calls.some((args) => args.slice(0, 2).join(" ") === "agent get")).toBe(true);
    } finally { restore(); }
  });

  test("retries agent_not_found during initial registration", async () => {
    const restore = isolatedHerdrEnv();
    let getCalls = 0;
    const pi: any = { exec: async (_command: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return ok({ agent: { agent_status: "unknown", launch_pending: true } });
      if (key === "agent get") {
        getCalls += 1;
        if (getCalls === 1) return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not registered yet" } }) };
        return readyAgent();
      }
      return ok();
    } };
    try {
      await launchHerdrAgent(pi, "Inspect only", "Late registration", "luna", routes.luna, "/repo");
      expect(getCalls).toBe(2);
    } finally { restore(); }
  });

  test("retains a started pane when readiness times out", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return ok({ agent: { agent_status: "unknown", launch_pending: true } });
      if (key === "agent get") return ok({ agent: { agent_status: "idle", launch_pending: true } });
      return ok();
    } };
    try {
      await expect(launchHerdrAgent(pi, "Inspect only", "Never ready", "luna", routes.luna, "/repo", 25)).rejects.toThrow("agent_start_timeout");
      expect(calls.some((args) => args.join(" ") === "tab close w1:t2")).toBe(false);
      expect(calls.some((args) => args.slice(0, 2).join(" ") === "agent prompt")).toBe(false);
    } finally { restore(); }
  });

  test("additional agents split the largest pane in the dedicated tab", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [{ tab_id: "w1:t2", label: "Routed agents · t1", pane_count: 2 }] });
      if (key === "pane list") return ok({ panes: [{ pane_id: "w1:p2", tab_id: "w1:t2" }, { pane_id: "w1:p3", tab_id: "w1:t2" }] });
      if (key === "pane layout") return ok({ layout: { panes: [
        { pane_id: "w1:p2", rect: { width: 80, height: 40 } },
        { pane_id: "w1:p3", rect: { width: 160, height: 40 } },
      ] } });
      if (key === "pane split") return ok({ pane: { pane_id: "w1:p4" } });
      if (key === "agent start") return readyAgent();
      return ok();
    } };
    try {
      const launched = await launchHerdrAgent(pi, "Inspect only", "Second task", "luna", routes.luna, "/repo");
      expect(launched.tabId).toBe("w1:t2");
      expect(launched.paneId).toBe("w1:p4");
      const split = calls.find((args) => args.slice(0, 2).join(" ") === "pane split")!;
      expect(split.slice(0, 6)).toEqual(["pane", "split", "--pane", "w1:p3", "--direction", "right"]);
      expect(split).not.toContain("w1:p1");
      expect(calls.some((args) => args.slice(0, 2).join(" ") === "tab create")).toBe(false);
    } finally { restore(); }
  });

  test("full routed tabs overflow into another dedicated tab", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [{ tab_id: "w1:t2", label: "Routed agents · t1", pane_count: ROUTED_TAB_MAX_PANES }] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p5" } });
      if (key === "agent start") return readyAgent();
      return ok();
    } };
    try {
      const launched = await launchHerdrAgent(pi, "Inspect only", "Overflow task", "luna", routes.luna, "/repo");
      expect(launched.tabId).toBe("w1:t3");
      const create = calls.find((args) => args.slice(0, 2).join(" ") === "tab create")!;
      expect(create).toContain("Routed agents · t1 · 2");
      expect(calls.some((args) => args.slice(0, 2).join(" ") === "pane split")).toBe(false);
    } finally { restore(); }
  });

  test("recovers a stalled prompt by submitting the existing composer text once", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return readyAgent();
      if (key === "agent prompt") return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "prompt did not start" } }) };
      return ok();
    } };
    try {
      await launchHerdrAgent(pi, "Inspect only", "Recover task", "luna", routes.luna, "/repo");
      expect(calls.filter((args) => args.slice(0, 2).join(" ") === "agent prompt")).toHaveLength(1);
      expect(calls.some((args) => args.join(" ").includes("agent send-keys") && args.includes("enter"))).toBe(true);
      expect(calls.some((args) => args.slice(0, 2).join(" ") === "agent wait" && args.includes("working"))).toBe(true);
    } finally { restore(); }
  });

  test("retains a started pane when prompt verification fails ambiguously", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return readyAgent();
      if (key === "agent prompt") return { code: 1, stdout: "", stderr: "herdr_socket_error: disconnected" };
      return ok();
    } };
    try {
      await expect(launchHerdrAgent(pi, "Inspect only", "Retain task", "luna", routes.luna, "/repo")).rejects.toThrow("pane w1:p2 was retained");
      expect(calls.some((args) => args.join(" ") === "tab close w1:t2")).toBe(false);
      expect(calls.some((args) => args.join(" ") === "pane close w1:p2")).toBe(false);
    } finally { restore(); }
  });

  test("failed startup closes a newly owned tab", async () => {
    const restore = isolatedHerdrEnv();
    const calls: string[][] = [];
    const pi: any = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return ok({ tabs: [] });
      if (key === "tab create") return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
      if (key === "agent start") return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "start_failed", message: "boom" } }) };
      return ok();
    } };
    try {
      await expect(launchHerdrAgent(pi, "Inspect only", "Broken task", "luna", routes.luna, "/repo")).rejects.toThrow("start_failed");
      expect(calls.some((args) => args.join(" ") === "tab close w1:t2")).toBe(true);
      expect(calls.some((args) => args.join(" ") === "pane close w1:p2")).toBe(false);
    } finally { restore(); }
  });
});
