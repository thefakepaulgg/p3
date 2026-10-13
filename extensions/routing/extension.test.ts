import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { saveAssignmentResult, writeAssignmentReceipt, resultRefForAssignment, resultPathForAssignment } from "./artifacts.ts";
import routing from "../model-routing.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";
import { manifestPathForPane, readRoutingManifest, ROUTING_MANIFEST_VERSION, writeRoutingManifest } from "./manifest.ts";
import { NOTIFICATION_LIMIT, WIDGET_RECENT_WINDOW_MS } from "./state.ts";

setHerdrTestTransportForTests(async (pi: any, args, timeout) => {
  const result = await pi.exec("herdr", args, { timeout });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "test Herdr request failed");
  return result.stdout.trim();
});

let temp: string | undefined;
let agentDir: string;
let previousAgentDir: string | undefined;
let defaultSession: string;
const workerSessionId = "worker-session";
const sessionHeader = () => JSON.stringify({ type: "session", version: 3, id: workerSessionId, timestamp: new Date().toISOString(), cwd: "/repo" });
beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "routing-ext-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  defaultSession = join(agentDir, "worker.jsonl");
  writeFileSync(defaultSession, `${sessionHeader()}\n`);
});
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});
const workerAgent = (status: string, sessionPath = defaultSession, paneId = "w1:p2") => ({
  pane_id: paneId, terminal_id: `terminal-${paneId}`, agent_status: status, interactive_ready: true, agent_session: { value: sessionPath },
});
const seedCompletion = (assignmentId: string, requestId: string, sessionPath: string, text: string, generation = 1) => {
  const resultHash = saveAssignmentResult(requestId, generation, workerSessionId, "response", text);
  writeAssignmentReceipt({ version: 1, assignmentId, requestId, generation, sessionId: workerSessionId, sessionPath,
    paneId: "w1:p2", terminalId: "terminal-w1:p2", outcome: "completed", lastActivityAt: Date.now(), responseEntryId: "response", resultHash });
};
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = undefined; });

const herdrEnv = () => {
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

const sessionWith = (text: string) => {
  temp = mkdtempSync(join(tmpdir(), "routing-ext-"));
  const file = join(temp, "session.jsonl");
  writeFileSync(file, `${sessionHeader()}\n${JSON.stringify({ type: "message", id: "response", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } })}\n`);
  return file;
};

/** Unit-only native outcome evidence; smoke transports must never seed success. */
const completedHerdrExec = (sessionPath: string, calls: string[][] = []) => {
  let assignmentId: string | undefined;
  let generation = 0;
  return async (_command: string, args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const ok = (result: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
    if (key === "tab list") return ok({ tabs: [] });
    if (key === "pane list") return ok({ panes: [{ pane_id: "w1:p2" }] });
    if (key === "tab create") {
      assignmentId = args.find((arg) => arg.startsWith("PI_ROUTED_ASSIGNMENT_ID="))?.split("=")[1];
      return ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
    }
    if (key === "agent prompt" && assignmentId && sessionPath !== "/nonexistent") {
      const requestId = /^p3:routed-request ([0-9a-f-]{36})\n/.exec(args[3]!)?.[1];
      if (requestId) {
        const messages = readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const response = messages.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        seedCompletion(assignmentId, requestId, sessionPath, response.message.content.map((part: any) => part.text ?? "").join("\n"), ++generation);
      }
    }
    if (key === "agent start") return ok({ agent: workerAgent("working", sessionPath === "/nonexistent" ? defaultSession : sessionPath) });
    if (key === "agent get") return ok({ agent: workerAgent("idle", sessionPath === "/nonexistent" ? defaultSession : sessionPath) });
    return ok();
  };
};

const sessionManager = (entries: any[] = []) => ({
  getEntries: () => entries, getSessionId: () => "session-1", getSessionDir: () => temp ?? "/tmp", getSessionFile: () => undefined,
});

const uiCtx = (widgets: Array<{ key: string; content: string[] | undefined }> = [], colors: string[] = []): any => ({
  hasUI: true, mode: "rpc", cwd: "/repo", sessionManager: sessionManager(),
  modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
  ui: {
    setStatus: () => {}, theme: { fg: (color: string, text: string) => { colors.push(color); return text; }, bold: (text: string) => text },
    setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
  },
});

test("registers the simplified public surface", () => {
  const tools: any[] = [];
  const commands: string[] = [];
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on: () => {}, appendEntry: () => {}, sendMessage: () => {},
    events: { on: () => () => {}, emit: () => {} }, exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  };
  routing(fake);
  expect(tools.map((tool) => tool.name)).toEqual(["workspace_agent", "workspace_agent_control", "peer_connection", "message_agent", "peer_inbox", "peer_message_status", "message_parent", "subagent", "subagent_control", "model_route"]);
  const properties = tools.find((tool) => tool.name === "subagent").parameters.properties;
  expect(properties.files.type).toBe("array");
  expect(properties.readonly.type).toBe("boolean");
  expect(properties.surface).toBeUndefined();
  expect(properties.isolation).toBeUndefined();
  expect(properties.route.type).toBe("string");
  expect(properties.route.enum).toBeUndefined();
  expect(properties.effort.enum).toEqual(["off", "minimal", "low", "medium", "high"]);
  expect(properties.capabilities.type).toBe("array");
  expect(properties.capabilities.items).toEqual({ type: "string", enum: ["memory"] });
  expect(commands).toEqual(["subagents", "route"]);
});

test("public subagent rejects unsupported capabilities before launch", async () => {
  const tools: any[] = [];
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, on: () => {}, appendEntry: () => {}, sendMessage: () => {},
    events: { on: () => () => {}, emit: () => {} }, exec: async () => { throw new Error("Herdr must not be called"); },
  };
  routing(fake);
  const launch = tools.find((tool) => tool.name === "subagent");
  await expect(launch.execute("1", { task: "Inspect", description: "Inspect task", capabilities: ["shell"] }, undefined, undefined, uiCtx())).rejects.toThrow("capabilities must contain only memory");
  await expect(launch.execute("2", { task: "Inspect", description: "Inspect task", effort: "extreme" }, undefined, undefined, uiCtx())).rejects.toThrow("unsupported effort level extreme");
  for (const effort of ["xhigh", "max"]) await expect(launch.execute("3", { task: "Inspect", description: "Inspect task", effort }, undefined, undefined, uiCtx())).rejects.toThrow("maximum effort is high");
});

test("launches an explicitly requested model outside the programmed routes", async () => {
  const restoreEnv = herdrEnv();
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const calls: string[][] = [];
  const model = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra", reasoning: true };
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return { code: 0, stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "" };
      if (key === "tab create") return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }), stderr: "" };
      if (key === "agent get") return { code: 0, stdout: JSON.stringify({ result: { agent: workerAgent("working") } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
    },
  };
  const ctx: any = {
    hasUI: true, cwd: "/repo", sessionManager: sessionManager(),
    modelRegistry: { getAll: () => [model], find: () => undefined, hasConfiguredAuth: () => true },
    ui: { setStatus: () => {}, setWidget: () => {}, theme: { fg: (_: string, text: string) => text } },
  };
  try {
    routing(fake);
    const launch = tools.find((tool) => tool.name === "subagent");
    const launched = await launch.execute("1", { task: "Inspect the change", description: "Inspect change", route: "gpt-6-astra", effort: "high", capabilities: ["memory"] }, undefined, undefined, ctx);
    expect(launched.details.model).toBe("openai-codex/gpt-6-astra");
    expect(launched.details.thinking).toBe("high");
    expect(launched.details.capabilities).toEqual(["memory"]);
    const startArgs = calls.find((args) => args.slice(0, 2).join(" ") === "agent start")!;
    expect(startArgs).toContain("openai-codex/gpt-6-astra");
    expect(startArgs).toContain("high");
    expect(startArgs).not.toContain("--no-extensions");
    expect(startArgs).toContain("subagent,subagent_control,workspace_agent,workspace_agent_control,peer_connection,model_route,workflow_control,pr_subscribe,pr_unsubscribe");
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("automatic launches use the routing classifier configured in Pi settings; explicit routes bypass it", async () => {
  const restoreEnv = herdrEnv();
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const classified: string[] = [];
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    getSettings: () => ({ p3: { routingClassifiers: ["openai/gpt-6-luna"] } }),
    exec: completedHerdrExec("/nonexistent"),
  };
  const ctx = uiCtx();
  ctx.model = { provider: "anthropic", id: "claude-sonnet" };
  ctx.modelRegistry.getAvailableOfType = async (_type: string, provider: string) => provider === "openai" ? [{ provider: "openai", id: "gpt-6-luna" }] : [];
  ctx.modelRegistry.classify = async (model: any) => {
    classified.push(`${model.provider}/${model.id}`);
    return { stopReason: "stop", answers: { tier: { type: "choice", choice: "small", confidence: 0.95 } } };
  };
  try {
    routing(fake);
    const launch = tools.find((tool) => tool.name === "subagent");
    const automatic = await launch.execute("1", { task: "Rename the field exactly as specified", description: "Rename field" }, undefined, undefined, ctx);
    expect(classified).toEqual(["openai/gpt-6-luna"]);
    expect(automatic.details.decision.tier).toBe("small");
    expect(automatic.details.decision.rationale).toContain("openai/gpt-6-luna selected small");
    await launch.execute("2", { task: "Inspect the change", description: "Inspect change", route: "sol" }, undefined, undefined, ctx);
    expect(classified).toHaveLength(1);
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("registers routed-agent navigation input in TUI mode", async () => {
  const restoreEnv = herdrEnv();
  const lifecycle = new Map<string, Function>();
  let terminalInputHandlers = 0;
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler),
    events: { on: () => () => {}, emit: () => {} },
    exec: async () => ({ code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
  };
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: "/repo", sessionManager: sessionManager(),
    ui: {
      setStatus: () => {}, setWidget: () => {},
      onTerminalInput: () => { terminalInputHandlers += 1; return () => {}; },
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  try {
    routing(fake);
    await lifecycle.get("session_start")?.({}, ctx);
    expect(terminalInputHandlers).toBe(1);
    await lifecycle.get("session_shutdown")?.({ reason: "reload" });
  } finally {
    restoreEnv();
  }
});

test("child panes render a parent row below the editor", async () => {
  const restoreEnv = herdrEnv();
  temp = mkdtempSync(join(tmpdir(), "routing-child-"));
  const path = join(temp, "manifest.json");
  writeRoutingManifest(path, {
    version: ROUTING_MANIFEST_VERSION, parentSessionId: "parent", parentPaneId: "w1:p1", updatedAt: 1,
    tasks: [{ handle: "rt-1", label: "Legacy worker", agentName: "worker", paneId: "w1:p2", route: "luna", model: "openai-codex/gpt-6-luna", state: "running", startedAt: 1 }],
  });
  writeRoutingManifest(manifestPathForPane(temp, "w1:p1"), {
    version: ROUTING_MANIFEST_VERSION, parentSessionId: "parent", parentPaneId: "w1:p1", updatedAt: 2,
    tasks: [{ handle: "rt-1", label: "Stable worker", agentName: "worker", paneId: "w1:p2", route: "luna", model: "openai-codex/gpt-6-luna", state: "running", startedAt: 1 }],
  });
  process.env.PI_ROUTING_MANIFEST = path;
  process.env.HERDR_PANE_ID = "w1:p2";
  const lifecycle = new Map<string, Function>();
  let rendered: string[] = [];
  let placement: string | undefined;
  const editor = { render: () => [], invalidate: () => {}, getText: () => "", setText: () => {}, handleInput: () => {} };
  let focused: any = editor;
  const tui: any = { getFocusedComponent: () => focused, setFocus: (value: any) => { focused = value; }, requestRender: () => {} };
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
  };
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: "/repo", sessionManager: sessionManager(),
    ui: {
      setStatus: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setWidget: (_key: string, content: any, options: any) => {
        placement = options?.placement;
        if (typeof content === "function") rendered = content(tui).render(120);
      },
    },
  };
  try {
    routing(fake);
    await lifecycle.get("session_start")?.({}, ctx);
    expect(placement).toBe("belowEditor");
    expect(rendered.join("\n")).toContain("Parent · main");
    expect(rendered.join("\n")).toContain("Stable worker");
    await lifecycle.get("session_shutdown")?.();
  } finally {
    delete process.env.PI_ROUTING_MANIFEST;
    restoreEnv();
  }
});

test("restores routed tasks when reopening the same Pi session", async () => {
  const restoreEnv = herdrEnv();
  temp = mkdtempSync(join(tmpdir(), "routing-restart-"));
  const path = manifestPathForPane(temp, "w1:p1");
  const assignmentId = randomUUID();
  const resultHash = saveAssignmentResult(assignmentId, 1, workerSessionId, "response", "Full restored result");
  writeRoutingManifest(path, {
    version: ROUTING_MANIFEST_VERSION, parentSessionId: "session-1", parentPaneId: "w1:p1", updatedAt: 1,
    tasks: [{ handle: "rt-old", label: "Retained worker", agentName: "worker", paneId: "w1:p2", route: "sol", model: "openai-codex/gpt-6-sol", state: "completed", startedAt: 1, endedAt: 2, assignmentId, requestId: assignmentId, sessionId: workerSessionId, terminalId: "terminal-w1:p2", resultHash, resultRef: resultRefForAssignment(assignmentId), resultPath: resultPathForAssignment(assignmentId), outcomeGeneration: 1, completionNotifiedAt: 2, completionDeliveredVia: "message" }],
  });
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
  };
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const ctx = uiCtx(widgets);
  ctx.sessionManager = { ...sessionManager(), getSessionDir: () => temp };
  try {
    routing(fake);
    await lifecycle.get("session_start")?.({}, ctx);
    const list = await tools.find((tool) => tool.name === "subagent_control").execute("1", { action: "list" }, undefined, undefined, ctx);
    expect(list.content[0].text).toContain("rt-old [completed]");
    const result = await tools.find((tool) => tool.name === "subagent_control").execute("2", { action: "result", handle: "rt-old" }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("Full restored result");
    expect(result.details.durable).toBe(true);
    await lifecycle.get("session_shutdown")?.();
    expect(readRoutingManifest(path)?.tasks[0]?.handle).toBe("rt-old");
  } finally {
    restoreEnv();
  }
});

test("does not restore routed agents or cost in a new Pi session", async () => {
  const restoreEnv = herdrEnv();
  temp = mkdtempSync(join(tmpdir(), "routing-new-session-"));
  const path = manifestPathForPane(temp, "w1:p1");
  writeRoutingManifest(path, {
    version: ROUTING_MANIFEST_VERSION, parentSessionId: "previous-session", parentPaneId: "w1:p1",
    sessionTotal: 73.83, sessionTotalKnown: true, updatedAt: 1,
    tasks: [{ handle: "rt-old", label: "Prior worker", agentName: "worker", paneId: "w1:p2", route: "luna", model: "openai-codex/gpt-6-luna", state: "completed", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000, estimatedCost: 0.09, costKnown: true }],
  });
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async () => ({ code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
  };
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const ctx = uiCtx(widgets);
  ctx.sessionManager = { ...sessionManager(), getSessionDir: () => temp };
  try {
    routing(fake);
    await lifecycle.get("session_start")?.({}, ctx);
    const list = await tools.find((tool) => tool.name === "subagent_control").execute("1", { action: "list" }, undefined, undefined, ctx);
    expect(list.content[0].text).toBe("No subagents");
    expect(widgets.at(-1)).toEqual({ key: "routed-tasks", content: undefined });
    expect(readRoutingManifest(path)?.parentSessionId).toBe("session-1");
    expect(readRoutingManifest(path)?.tasks).toEqual([]);
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("blocks direct Agent launches that bypass guarded routing", async () => {
  let toolCall: Function | undefined;
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => { if (name === "tool_call") toolCall = handler; },
    events: { on: () => () => {}, emit: () => {} }, exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  };
  routing(fake);
  expect(await toolCall?.({ toolName: "Agent", input: {} })).toEqual({
    block: true,
    reason: "Direct Agent launch bypasses Herdr routing and dependency guards. Use subagent.",
  });
  expect(await toolCall?.({ toolName: "read", input: {} })).toBeUndefined();
});

test("every subagent uses Herdr and only overlapping owned paths conflict", async () => {
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  let pane = 0;
  const restoreEnv = herdrEnv();
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (_cmd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return { code: 0, stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "" };
      if (key === "tab create") {
        const next = ++pane + 1;
        return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: `w1:t${next}` }, root_pane: { pane_id: `w1:p${next}` } } }), stderr: "" };
      }
      if (key === "agent get") return { code: 0, stdout: JSON.stringify({ result: { agent: workerAgent("working", defaultSession, `w1:p${pane + 1}`) } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
    },
  };
  try {
    routing(fake);
    const launch = tools.find(tool => tool.name === "subagent");
    const ctx: any = { hasUI: true, cwd: "/repo", sessionManager: sessionManager(), modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true }, ui: { setStatus: () => {}, theme: { fg: (_: string, text: string) => text } } };
    const planned = await launch.execute("1", { task: "Create the implementation plan", description: "Plan change", route: "sol" }, undefined, undefined, ctx);
    expect(planned.details.agent).toMatch(/^r-/);
    expect(planned.details.phase).toBe("plan");
    const implemented = await launch.execute("2", { task: "Implement the planned change", description: "Implement change", route: "luna" }, undefined, undefined, ctx);
    expect(implemented.details.phase).toBe("implement");
    await expect(launch.execute("3", { task: "Edit the parser", description: "Parser A", route: "luna", owned_paths: ["src/parser"] }, undefined, undefined, ctx)).resolves.toBeDefined();
    await expect(launch.execute("4", { task: "Edit the parser tests", description: "Parser B", route: "luna", owned_paths: ["src/parser/tests"] }, undefined, undefined, ctx)).rejects.toThrow("overlapping paths");
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("Herdr completion delivers exactly one bounded custom message as a steer turn", async () => {
  const restoreEnv = herdrEnv();
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const entries: any[] = [];
  const messages: any[] = [];
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const colors: string[] = [];
  const worker = `Implemented the bounded slice. ${"D".repeat(9000)}`;
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {},
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: completedHerdrExec(sessionWith(worker)),
  };
  try {
    routing(fake);
    const launch = tools.find((tool) => tool.name === "subagent");
    const control = tools.find((tool) => tool.name === "subagent_control");
    const ctx = uiCtx(widgets, colors);
    const launched = await launch.execute("1", { task: "Inspect the implementation", description: "Inspect change", route: "luna" }, undefined, undefined, ctx);
    for (let tick = 0; tick < 10 && !messages.length; tick += 1) await new Promise((done) => setTimeout(done, 40));

    expect(messages).toHaveLength(1);
    const [delivered] = messages;
    expect(delivered.message.customType).toBe("subagent-completion");
    expect(delivered.message.display).toBe(true);
    expect(delivered.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(delivered.message.content.length).toBeLessThanOrEqual(NOTIFICATION_LIMIT);
    expect(delivered.message.content).not.toContain("D".repeat(700));
    expect(delivered.message.content).toContain(`subagent_control action=result handle=${launched.details.handle}`);
    expect(delivered.message.details.kind).toBe("completed");

    await lifecycle.get("message_end")?.({ message: { role: "custom", ...delivered.message } }, ctx);

    // The full result stays retrievable, and reading it does not add another turn.
    const cached = await control.execute("2", { action: "result", handle: launched.details.handle }, undefined, undefined, ctx);
    expect(cached.content[0].text).toContain("Implemented the bounded slice.");
    expect(cached.details.cached).toBe(true);
    expect(cached.details.consumedManually).toBe(false);
    expect(messages).toHaveLength(1);

    // Telemetry keeps the result body out of the session log.
    const routedEntries = entries.filter((entry) => entry.type === "routed-task");
    expect(routedEntries.length).toBeGreaterThan(0);
    expect(JSON.stringify(routedEntries)).not.toContain("Implemented the bounded slice");
    const completedEntry = routedEntries.map((entry) => entry.data).filter((data: any) => data.state === "completed").at(-1);
    expect(completedEntry.resultChars).toBe(worker.length);
    expect(completedEntry.result).toBeUndefined();
    expect(completedEntry.notifiedStates).toEqual(["completed"]);
    expect(completedEntry.completionDeliveredVia).toBe("message");
    expect(completedEntry.paneRetention).toBe("keep");

    // The widget tracks the task and then its completion.
    expect(widgets.every((entry) => entry.key === "routed-tasks")).toBe(true);
    const rows = widgets.at(-1)!.content!;
    expect(rows[0]).toContain("╭─ Subagents · 1 recent");
    expect(rows[1]).toContain("✓ Inspect change · gpt-6-luna");
    expect(rows.join(" ")).not.toContain(launched.details.handle);
    expect(rows.join(" ")).not.toContain("rt-");
    expect(rows.join(" ")).not.toContain("w1:p2");
    expect(rows.at(-1)).toContain("╰─");
    expect(colors).toEqual(expect.arrayContaining(["accent", "success", "text", "muted", "dim"]));

    await lifecycle.get("session_shutdown")?.();
    expect(widgets.at(-1)).toEqual({ key: "routed-tasks", content: undefined });
  } finally {
    restoreEnv();
  }
});

test("steering a completed task delivers the next completion", async () => {
  const restoreEnv = herdrEnv();
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const messages: any[] = [];
  const sessionPath = sessionWith("I am blocked pending a decision.");
  let promptCount = 0;
  const nativeExec = completedHerdrExec(sessionPath);
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {},
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (command: string, args: string[]) => {
      if (args.slice(0, 2).join(" ") === "agent prompt" && ++promptCount === 2) {
        writeFileSync(sessionPath, `${sessionHeader()}\n${JSON.stringify({ type: "message", id: "response", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed after receiving the decision." }] } })}\n`);
      }
      return nativeExec(command, args);
    },
  };
  try {
    routing(fake);
    const launch = tools.find((tool) => tool.name === "subagent");
    const control = tools.find((tool) => tool.name === "subagent_control");
    const ctx = uiCtx();
    const launched = await launch.execute("1", { task: "Inspect the implementation", description: "Inspect change", route: "luna" }, undefined, undefined, ctx);
    for (let tick = 0; tick < 10 && messages.length < 1; tick += 1) await new Promise((done) => setTimeout(done, 40));
    expect(messages.filter((entry) => entry.message.customType === "subagent-completion")).toHaveLength(1);

    await lifecycle.get("message_end")?.({ message: { role: "custom", ...messages[0].message } }, ctx);
    await control.execute("2", { action: "steer", handle: launched.details.handle, message: "Use the user's decision and continue." }, undefined, undefined, ctx);
    for (let tick = 0; tick < 10 && messages.length < 2; tick += 1) await new Promise((done) => setTimeout(done, 40));

    const completions = messages.filter((entry) => entry.message.customType === "subagent-completion");
    expect(completions).toHaveLength(2);
    expect(completions[1].message.content).toContain("Completed after receiving the decision.");
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("a stale TUI widget renders nothing after its routed tasks expire", async () => {
  const restoreEnv = herdrEnv();
  const originalNow = Date.now;
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const messages: any[] = [];
  let staleWidget: any;
  let now = originalNow();
  Date.now = () => now;
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {},
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: completedHerdrExec(sessionWith("Completed")),
  };
  const editor = { render: () => [], invalidate: () => {}, getText: () => "", setText: () => {}, handleInput: () => {} };
  const tui: any = { getFocusedComponent: () => editor, setFocus: () => {}, requestRender: () => {} };
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: "/repo", sessionManager: sessionManager(),
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
    ui: {
      setStatus: () => {}, theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setWidget: (_key: string, content: any) => { if (typeof content === "function") staleWidget = content(tui); },
      notify: () => {},
    },
  };
  try {
    routing(fake);
    const launch = tools.find((tool) => tool.name === "subagent");
    await launch.execute("1", { task: "Inspect", description: "Expiring task", route: "luna" }, undefined, undefined, ctx);
    for (let tick = 0; tick < 10 && !messages.length; tick += 1) await new Promise((done) => setTimeout(done, 40));
    expect(staleWidget).toBeDefined();
    now += WIDGET_RECENT_WINDOW_MS + 1;
    expect(staleWidget.render(120)).toEqual([]);
    await lifecycle.get("session_shutdown")?.();
  } finally {
    Date.now = originalNow;
    restoreEnv();
  }
});

test("replayed completion claims are not delivered twice after reload", async () => {
  const restoreEnv = herdrEnv();
  const lifecycle = new Map<string, Function>();
  const messages: any[] = [];
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const replayed = {
    handle: "rt-replay", route: "luna", routeExplicit: false, target: "herdr",
    model: "openai-codex/gpt-6-luna", thinking: "high", label: "Replayed task", state: "completed", endedAt: Date.now() - 1000,
    startedAt: Date.now() - 5000, agentName: "r-replay", paneId: "w1:p2", paneRetention: "keep",
    transitions: 1, notifiedStates: ["completed"], completionNotifiedAt: Date.now() - 1000, completionDeliveredVia: "message",
  };
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: completedHerdrExec(sessionWith("Fresh transcript text after reload")),
  };
  try {
    routing(fake);
    const ctx = uiCtx(widgets);
    ctx.sessionManager = sessionManager([{ type: "custom", customType: "routed-task", data: replayed }]);
    await lifecycle.get("session_start")?.({}, ctx);
    await new Promise((done) => setTimeout(done, 200));
    expect(messages).toHaveLength(0);
    // The task still reaches its terminal state; only the duplicate announcement is suppressed.
    expect(widgets.at(-1)!.content!.join("\n")).toContain("✓ Replayed task · gpt-6-luna");
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("manual retrieval without a matching durable tool receipt does not consume delivery", async () => {
  const restoreEnv = herdrEnv();
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const messages: any[] = [];
  let status = "working";
  const sessionPath = sessionWith("Manual read result body");
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {},
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (_command: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return { code: 0, stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "" };
      if (key === "tab create") return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }), stderr: "" };
      if (key === "agent get") return { code: 0, stdout: JSON.stringify({ result: { agent: workerAgent(status, sessionPath) } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
    },
  };
  try {
    routing(fake);
    const launch = tools.find((tool) => tool.name === "subagent");
    const control = tools.find((tool) => tool.name === "subagent_control");
    const ctx = uiCtx();
    const launched = await launch.execute("1", { task: "Inspect the implementation", description: "Inspect change", route: "luna" }, undefined, undefined, ctx);
    // Stop the watcher, mark the task completed by hand, then consume the result manually.
    await control.execute("2", { action: "stop", handle: launched.details.handle }, undefined, undefined, ctx);
    const tracked = (await control.execute("3", { action: "list" }, undefined, undefined, ctx)).details.tasks[0];
    Object.assign(tracked, { state: "completed", endedAt: Date.now(), result: "Manual read result body", resultChars: 23 });
    const first = await control.execute("4", { action: "result", handle: launched.details.handle }, undefined, undefined, ctx);
    expect(first.details.consumedManually).toBe(false);
    expect(tracked.completionDeliveredVia).toBeUndefined();
    // Idle alone cannot establish a new completed result after steering.
    status = "idle";
    await control.execute("5", { action: "steer", handle: launched.details.handle, message: "continue" }, undefined, undefined, ctx);
    await new Promise((done) => setTimeout(done, 200));
    expect(messages.filter((entry) => entry.message.customType === "subagent-completion")).toHaveLength(0);
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("retained Herdr panes can be focused and explicitly closed", async () => {
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const calls: string[][] = [];
  const restoreEnv = herdrEnv();
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (_cmd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return { code: 0, stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "" };
      if (key === "pane list") return { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p2" }] } }), stderr: "" };
      if (key === "tab create") return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }), stderr: "" };
      if (key === "agent get") return { code: 0, stdout: JSON.stringify({ result: { agent: workerAgent("working") } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
    },
  };
  try {
    routing(fake);
    const launch = tools.find(tool => tool.name === "subagent");
    const control = tools.find(tool => tool.name === "subagent_control");
    const ctx: any = { hasUI: true, cwd: "/repo", sessionManager: sessionManager(), modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true }, ui: { setStatus: () => {}, theme: { fg: (_: string, text: string) => text } } };
    const launched = await launch.execute("1", { task: "Inspect the implementation", description: "Inspect change", route: "luna" }, undefined, undefined, ctx);
    expect(launched.content[0].text).toContain("pane w1:p2");
    expect(launched.content[0].text).toContain("Do not poll");
    await control.execute("2", { action: "focus", handle: launched.details.handle });
    expect(calls.some(args => args.join(" ") === "pane focus w1:p2")).toBe(true);
    await expect(control.execute("3", { action: "clear", handle: launched.details.handle })).rejects.toThrow("Active tasks cannot be cleared");
    await control.execute("4", { action: "stop", handle: launched.details.handle });
    await control.execute("5", { action: "close", handle: launched.details.handle });
    expect(calls.some(args => args.join(" ") === "pane close w1:p2")).toBe(true);
    const list = await control.execute("6", { action: "list" });
    expect(list.content[0].text).toContain("pane closed");
    await control.execute("7", { action: "clear", handle: launched.details.handle });
    expect((await control.execute("8", { action: "list" })).content[0].text).toBe("No subagents");
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("stop with close aborts tracking, records the closed pane, and exposes live Herdr status", async () => {
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const calls: string[][] = [];
  const messages: any[] = [];
  const restoreEnv = herdrEnv();
  let agentStatus = "unknown";
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {},
    sendMessage: (message: any) => messages.push(message),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (_cmd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return { code: 0, stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "" };
      if (key === "tab create") return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }), stderr: "" };
      if (key === "agent start") return { code: 0, stdout: JSON.stringify({ result: { agent: workerAgent("working") } }), stderr: "" };
      if (key === "agent get") return { code: 0, stdout: JSON.stringify({ result: { agent: workerAgent(agentStatus) } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
    },
  };
  try {
    routing(fake);
    const launch = tools.find(tool => tool.name === "subagent");
    const control = tools.find(tool => tool.name === "subagent_control");
    const ctx = uiCtx();
    const launched = await launch.execute("1", { task: "Inspect the implementation", description: "Inspect change", route: "luna" }, undefined, undefined, ctx);
    const status = await control.execute("2", { action: "status", handle: launched.details.handle }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("Herdr status: unknown");

    agentStatus = "working";
    await control.execute("3", { action: "stop", handle: launched.details.handle, close_pane: true }, undefined, undefined, ctx);
    const list = await control.execute("4", { action: "list" }, undefined, undefined, ctx);
    expect(list.content[0].text).toContain("[stopped]");
    expect(list.content[0].text).toContain("pane closed");
    expect(list.details.tasks[0].paneClosedAt).toBeNumber();
    expect(calls.some(args => args.join(" ") === "pane close w1:p2")).toBe(true);
    await new Promise((done) => setTimeout(done, 30));
    expect(messages).toHaveLength(0);
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

test("routing RPC refuses launches outside the user-facing root session", async () => {
  const lifecycle = new Map<string, Function>();
  const listeners = new Map<string, Set<Function>>();
  const on = (name: string, handler: Function) => {
    const set = listeners.get(name) ?? new Set<Function>();
    set.add(handler); listeners.set(name, set);
    return () => set.delete(handler);
  };
  const emit = (name: string, payload: any) => {
    for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
  };
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on, emit },
    exec: async () => ({ code: 1, stdout: "", stderr: "should not execute" }),
  };
  routing(fake);
  const ctx: any = {
    hasUI: false, cwd: "/tmp",
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
    ui: { setStatus: () => {}, setWidget: () => {}, theme: { fg: (_: string, text: string) => text } },
    sessionManager: sessionManager(),
  };
  await lifecycle.get("session_start")?.({}, ctx);
  const reply = new Promise<any>((resolve) => on("routing:rpc:launch:reply:req-no-ui", resolve));
  emit("routing:rpc:launch", {
    requestId: "req-no-ui", version: 1, task: "Do work", description: "Workflow step",
    owner: { kind: "workflow", runId: "run-1", stepId: "step-1", attemptId: "attempt-1" },
  });
  expect(await reply).toEqual({ success: false, error: "routing RPC can only launch from the user-facing root Pi session" });
  await lifecycle.get("session_shutdown")?.();
});

test("/subagents opens a retained pane and clear survives reload", async () => {
  const restoreEnv = herdrEnv();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, Function>();
  const entries: any[] = [];
  const calls: string[][] = [];
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const notices: Array<{ text: string; level: string }> = [];
  const replayed = {
    handle: "rt-stored", route: "sol", routeExplicit: true, target: "herdr",
    model: "openai-codex/gpt-6-sol", thinking: "medium", label: "Stored agent", state: "completed",
    startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000, agentName: "r-stored", paneId: "w1:p9", terminalId: "terminal-w1:p9", sessionId: workerSessionId, paneRetention: "keep",
    transitions: 2, notifiedStates: ["completed"], completionNotifiedAt: Date.now() - 30_000, completionDeliveredVia: "message",
  };
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (type: string, data: any) => entries.push({ type, data }), sendMessage: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const result = args.slice(0, 2).join(" ") === "pane list" ? { panes: [{ pane_id: "w1:p9" }] } : args.slice(0, 2).join(" ") === "agent get" ? { agent: workerAgent("idle", defaultSession, "w1:p9") } : {};
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    },
  };
  try {
    routing(fake);
    const ctx = uiCtx(widgets);
    let selectCall = 0;
    ctx.ui.select = async (_title: string, options: string[]) => selectCall++ === 0 ? options[0] : "Open pane";
    ctx.ui.notify = (text: string, level: string) => notices.push({ text, level });
    ctx.sessionManager = sessionManager([{ type: "custom", customType: "routed-task", data: replayed }]);
    await lifecycle.get("session_start")?.({}, ctx);
    const complete = commands.get("subagents").getArgumentCompletions;
    expect(complete("focus ")).toEqual([{ value: "focus Stored agent", label: "Stored agent", description: "gpt-6-sol · completed" }]);
    expect(complete("result Stor")[0].value).toBe("result Stored agent");
    expect(complete("focus rt-")[0].value).toBe("focus rt-stored");
    expect(complete("clear missing")).toBeNull();
    await commands.get("subagents").handler("", ctx);
    expect(calls.some((args) => args.join(" ") === "pane focus w1:p9")).toBe(true);
    expect(notices.at(-1)?.text).toBe("Opened Stored agent");

    await commands.get("subagents").handler("clear", ctx);
    expect(notices.at(-1)?.text).toContain("Cleared 1 finished subagent");
    expect(notices.at(-1)?.text).toContain("1 retained pane remains open");
    const cleared = entries.filter((entry) => entry.type === "routed-task").at(-1)?.data;
    expect(cleared.clearedAt).toBeNumber();
    expect(widgets.at(-1)).toEqual({ key: "routed-tasks", content: undefined });

    const reloadTools: any[] = [];
    const reloadLifecycle = new Map<string, Function>();
    const reloadFake: any = {
      registerVirtualModel: () => {}, registerTool: (tool: any) => reloadTools.push(tool), registerCommand: () => {}, appendEntry: () => {}, sendMessage: () => {},
      on: (name: string, handler: Function) => reloadLifecycle.set(name, handler), events: { on: () => () => {}, emit: () => {} },
      exec: async () => ({ code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
    };
    routing(reloadFake);
    const reloadCtx = uiCtx();
    reloadCtx.sessionManager = sessionManager([{ type: "custom", customType: "routed-task", data: cleared }]);
    await reloadLifecycle.get("session_start")?.({}, reloadCtx);
    const list = reloadTools.find((tool) => tool.name === "subagent_control");
    expect((await list.execute("1", { action: "list" })).content[0].text).toBe("No subagents");
    await reloadLifecycle.get("session_shutdown")?.();
    await lifecycle.get("session_shutdown")?.();
  } finally {
    restoreEnv();
  }
});

const completionFixture = async (paneRetention: "keep" | "close" = "keep") => {
  const tools: any[] = [];
  const lifecycle = new Map<string, Function>();
  const messages: any[] = [];
  const calls: string[][] = [];
  const savedEntries: any[] = [];
  const sessionPath = sessionWith("Durable completed result");
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, appendEntry: () => {},
    on: (name: string, handler: Function) => lifecycle.set(name, handler),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    events: { on: () => () => {}, emit: () => {} }, exec: completedHerdrExec(sessionPath, calls),
  };
  routing(fake);
  const ctx = uiCtx();
  ctx.sessionManager = sessionManager(savedEntries);
  await lifecycle.get("session_start")!({}, ctx);
  const control = tools.find((tool) => tool.name === "subagent_control");
  const launched = await tools.find((tool) => tool.name === "subagent").execute("launch", {
    task: "Inspect implementation", description: "Receipt task", route: "luna", pane_retention: paneRetention,
  }, undefined, undefined, ctx);
  for (let tick = 0; tick < 10 && !messages.some((entry) => entry.message.customType === "subagent-completion"); tick += 1) await new Promise((done) => setTimeout(done, 40));
  const tracked = (await control.execute("list", { action: "list" }, undefined, undefined, ctx)).details.tasks.find((task: any) => task.handle === launched.details.handle);
  return { control, lifecycle, messages, calls, savedEntries, tracked, ctx };
};

test("pane auto-close follows matching custom message_end, not queued completion or mismatched receipts", async () => {
  const restore = herdrEnv();
  const fixture = await completionFixture("close");
  const { lifecycle, messages, calls, tracked, ctx } = fixture;
  try {
    expect(messages).toHaveLength(1);
    expect(tracked.pendingCompletion).toBe(true);
    expect(tracked.completionNotifiedAt).toBeUndefined();
    expect(calls.some((args) => args.join(" ") === "pane close w1:p2")).toBe(false);
    const message = { role: "custom", ...messages[0].message };
    await lifecycle.get("message_end")!({ message: { ...message, details: { ...message.details, assignmentId: randomUUID() } } }, ctx);
    await lifecycle.get("message_end")!({ message: { ...message, details: { ...message.details, generation: 999 } } }, ctx);
    expect(tracked.completionNotifiedAt).toBeUndefined();
    await lifecycle.get("message_end")!({ message }, ctx);
    for (let tick = 0; tick < 10 && !tracked.paneClosedAt; tick += 1) await new Promise((done) => setTimeout(done, 10));
    expect(tracked.pendingCompletion).toBe(false);
    expect(tracked.completionDeliveredVia).toBe("message");
    expect(tracked.paneClosedAt).toBeNumber();
    expect(calls.filter((args) => args.join(" ") === "pane close w1:p2")).toHaveLength(1);
    await lifecycle.get("message_end")!({ message }, ctx);
    await lifecycle.get("agent_settled")!({}, ctx);
    expect(messages).toHaveLength(1);
  } finally {
    await lifecycle.get("session_shutdown")?.();
    restore();
  }
});

test("aborted queued delivery requeues once for nextTurn; matching saved transcript consumes the single receipt", async () => {
  const restore = herdrEnv();
  const fixture = await completionFixture();
  const { lifecycle, messages, savedEntries, tracked, ctx } = fixture;
  try {
    expect(messages).toHaveLength(1);
    await lifecycle.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
    expect(tracked.completionNotifiedAt).toBeUndefined();
    await lifecycle.get("agent_settled")!({}, ctx);
    expect(messages).toHaveLength(2);
    expect(messages[1].options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
    await lifecycle.get("agent_settled")!({}, ctx);
    expect(messages).toHaveLength(2);
    savedEntries.push({ type: "custom_message", ...messages[1].message, details: { ...messages[1].message.details, generation: 999 } });
    await lifecycle.get("agent_settled")!({}, ctx);
    expect(tracked.completionNotifiedAt).toBeUndefined();
    savedEntries.push({ type: "custom_message", ...messages[1].message });
    await lifecycle.get("agent_settled")!({}, ctx);
    expect(tracked.completionDeliveredVia).toBe("message");
    expect(tracked.pendingCompletion).toBe(false);
    await lifecycle.get("agent_settled")!({}, ctx);
    expect(messages).toHaveLength(2);
  } finally {
    await lifecycle.get("session_shutdown")?.();
    restore();
  }
});

test("durable manual result retrieval is acknowledged only by its native toolResult message_end", async () => {
  const restore = herdrEnv();
  const { lifecycle, control, tracked, ctx } = await completionFixture();
  try {
    const result = await control.execute("read", { action: "result", handle: tracked.handle }, undefined, undefined, ctx);
    expect(result.details.durable).toBe(true);
    expect(tracked.completionNotifiedAt).toBeUndefined();
    await lifecycle.get("message_end")!({ message: { role: "toolResult", toolName: "subagent_control", details: result.details, content: result.content } }, ctx);
    expect(tracked.completionDeliveredVia).toBe("manual");
    expect(tracked.pendingCompletion).toBe(false);
  } finally {
    await lifecycle.get("session_shutdown")?.();
    restore();
  }
});
