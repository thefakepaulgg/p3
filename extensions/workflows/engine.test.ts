import { expect, test } from "bun:test";
import workflowEngine from "../workflow-engine.ts";
import { createRun } from "./scheduler.ts";
import { parseWorkflowYaml } from "./schema.ts";

function fake() {
  const tools: any[] = []; const commands = new Map<string, any>(); const lifecycle = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: () => {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    events: { on: (name: string, handler: Function) => { listeners.set(name, handler); return () => listeners.delete(name); }, emit: () => {} },
    on: (name: string, handler: Function) => lifecycle.set(name, handler),
  };
  return { pi, tools, commands, lifecycle, listeners };
}

const ctx: any = {
  mode: "print", hasUI: false, cwd: "/tmp", isProjectTrusted: () => false,
  sessionManager: { getBranch: () => [], getSessionId: () => "session-1", getSessionDir: () => "/tmp" },
  ui: { notify: () => {}, setWidget: () => {} },
};

test("registers workflow control and command without RPIV-specific code", () => {
  const harness = fake(); workflowEngine(harness.pi);
  expect(harness.tools.map((tool) => tool.name)).toEqual(["workflow_control"]);
  expect([...harness.commands.keys()]).toEqual(["workflow"]);
  const completions = harness.commands.get("workflow").getArgumentCompletions("");
  expect(completions.map((item: any) => item.value)).toEqual(["list", "validate", "start", "status", "continue", "retry", "back", "stop", "resume", "adopt"]);
  expect(harness.commands.get("workflow").getArgumentCompletions("st").map((item: any) => item.value)).toEqual(["start", "status", "stop"]);
  expect(harness.lifecycle.has("session_start")).toBe(true);
  expect(harness.lifecycle.has("session_tree")).toBe(true);
});

test("session tree reconstruction does not launch through routing RPC", async () => {
  const harness = fake(); workflowEngine(harness.pi);
  await harness.lifecycle.get("session_tree")?.({}, ctx);
  expect([...harness.listeners.keys()].filter((name) => name === "routing:rpc:launch")).toHaveLength(0);
});

test("restored runs from a fork require explicit adoption", async () => {
  const definition = parseWorkflowYaml(`
version: pi-workflow/v1
id: forked
name: Forked
description: fork test
inputs: { goal: { type: string, required: true } }
steps: [{ id: only, name: Only, route: luna, phase: other, prompt: "{{inputs.goal}}" }]
`);
  const run = createRun(definition, { goal: "x" }, "original-session"); run.status = "completed";
  const notices: string[] = []; const harness = fake(); workflowEngine(harness.pi);
  const forkCtx = { ...ctx, ui: { ...ctx.ui, notify: (text: string) => notices.push(text) }, sessionManager: { ...ctx.sessionManager, getSessionId: () => "fork-session", getBranch: () => [{ type: "custom", customType: "workflow-run-v1", data: run }] } };
  await harness.lifecycle.get("session_start")?.({ reason: "fork" }, forkCtx);
  await harness.commands.get("workflow").handler("status", forkCtx);
  expect(notices.at(-1)).toContain("fork-mismatch");
});
