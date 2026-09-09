import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workflowEngine from "../workflow-engine.ts";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

test("launches through routing RPC, consumes completion result, and writes an artifact", async () => {
  root = mkdtempSync(join(tmpdir(), "workflow-engine-"));
  const oldHome = process.env.HOME; process.env.HOME = root;
  const workflowDir = join(root, ".pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  await Bun.write(join(workflowDir, "one.yaml"), `
version: pi-workflow/v1
id: one
name: One
description: one
inputs: { goal: { type: string, required: true } }
defaults: { retry: 0 }
steps:
  - id: only
    name: Only
    route: luna
    phase: other
    prompt: "Do {{inputs.goal}}"
`);
  const tools: any[] = []; const commands = new Map<string, any>(); const lifecycle = new Map<string, Function>(); const listeners = new Map<string, Set<Function>>(); const entries: any[] = []; const launches: any[] = [];
  const on = (name: string, handler: Function) => { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); };
  const emit = (name: string, payload: any) => {
    if (name === "routing:rpc:launch") { launches.push(payload); queueMicrotask(() => [...(listeners.get(`${name}:reply:${payload.requestId}`) ?? [])].forEach((handler) => handler({ success: true, data: { handle: "rt-one" } }))); }
    if (name === "routing:rpc:result") queueMicrotask(() => [...(listeners.get(`${name}:reply:${payload.requestId}`) ?? [])].forEach((handler) => handler({ success: true, data: { handle: payload.handle, result: "done" } })));
    for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
  };
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string, command: any) => commands.set(name, command), appendEntry: (type: string, data: any) => entries.push({ type, data }),
    on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on, emit },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  const sessionDir = join(root, "session"); const ctx: any = { mode: "print", hasUI: false, cwd: root, isProjectTrusted: () => true, sessionManager: { getBranch: () => [], getSessionId: () => "session-1", getSessionDir: () => sessionDir }, ui: { notify: () => {}, setWidget: () => {} } };
  try {
    workflowEngine(pi);
    await lifecycle.get("session_start")?.({ reason: "startup" }, ctx);
    await commands.get("workflow").handler("start one goal", ctx);
    expect(launches[0].route).toBe("luna");
    expect(launches[0].owner.kind).toBe("workflow");
    const owner = launches[0].owner;
    emit("routing:task:completed", { state: "completed", handle: "rt-one", owner });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const output = join(sessionDir, "workflow-artifacts", owner.runId, owner.stepId, owner.attemptId, "output.md");
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("done");
    expect(entries.every((entry) => !JSON.stringify(entry.data).includes("done"))).toBe(true);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});

test("rejects a second live run and surfaces blocked worker state", async () => {
  root = mkdtempSync(join(tmpdir(), "workflow-engine-live-"));
  const oldHome = process.env.HOME; process.env.HOME = root;
  const workflowDir = join(root, ".pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  await Bun.write(join(workflowDir, "one.yaml"), `
version: pi-workflow/v1
id: one
name: One
description: one
inputs: { goal: { type: string, required: true } }
defaults: { retry: 0 }
steps:
  - id: only
    name: Only
    route: luna
    phase: other
    prompt: "Do {{inputs.goal}}"
`);
  const listeners = new Map<string, Set<Function>>(); const lifecycle = new Map<string, Function>(); const commands = new Map<string, any>(); const launches: any[] = []; const notices: Array<{ text: string; level: string }> = [];
  const on = (name: string, handler: Function) => { const set = listeners.get(name) ?? new Set<Function>(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); };
  const emit = (name: string, payload: any) => {
    if (name === "routing:rpc:launch") { launches.push(payload); queueMicrotask(() => { for (const handler of listeners.get(`${name}:reply:${payload.requestId}`) ?? []) handler({ success: true, data: { handle: "rt-live" } }); }); }
    if (name === "routing:rpc:status") queueMicrotask(() => { for (const handler of listeners.get(`${name}:reply:${payload.requestId}`) ?? []) handler({ success: true, data: { handle: payload.handle, state: "running" } }); });
    for (const handler of listeners.get(name) ?? []) handler(payload);
  };
  const pi: any = { registerTool: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), appendEntry: () => {}, on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on, emit }, exec: async () => ({ code: 1, stdout: "", stderr: "" }) };
  const ctx: any = { mode: "print", hasUI: false, cwd: root, isProjectTrusted: () => true, sessionManager: { getBranch: () => [], getSessionId: () => "session-live", getSessionDir: () => join(root, "session") }, ui: { notify: (text: string, level: string) => notices.push({ text, level }), setWidget: () => {} } };
  try {
    workflowEngine(pi);
    await lifecycle.get("session_start")?.({ reason: "startup" }, ctx);
    await commands.get("workflow").handler("start one first", ctx);
    expect(launches).toHaveLength(1);
    await commands.get("workflow").handler("start one second", ctx);
    expect(launches).toHaveLength(1);
    expect(notices.at(-1)?.text).toContain("still active");
    emit("routing:task:blocked", { state: "blocked", handle: "rt-live", owner: launches[0].owner });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await commands.get("workflow").handler("status", ctx);
    expect(notices.at(-1)?.text).toContain("[blocked]");
    expect(notices.some((notice) => notice.text.includes("needs input") && notice.text.includes("/routed"))).toBe(true);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});
