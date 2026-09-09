import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workflowEngine from "../workflow-engine.ts";
import { createRun, workflowReducer } from "./scheduler.ts";
import { parseWorkflowYaml } from "./schema.ts";

test("resume reconciles a live routed task without launching a duplicate", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-resume-")); const oldHome = process.env.HOME; process.env.HOME = root;
  try {
    const workflowDir = join(root, ".pi", "workflows"); mkdirSync(workflowDir, { recursive: true });
    await Bun.write(join(workflowDir, "one.yaml"), `version: pi-workflow/v1\nid: one\nname: One\ndescription: one\ninputs: { goal: { type: string, required: true } }\nsteps: [{ id: only, name: Only, route: luna, phase: other, prompt: "{{inputs.goal}}" }]\n`);
    const definition = parseWorkflowYaml(await Bun.file(join(workflowDir, "one.yaml")).text());
    let run = createRun(definition, { goal: "x" }, "session-1");
    run = workflowReducer(run, { type: "step-launched", stepId: "only", attempt: { attemptId: "a1", handle: "rt-live", status: "running", startedAt: 1 } });
    const listeners = new Map<string, Set<Function>>(); let launches = 0; let statuses = 0;
    const on = (name: string, handler: Function) => { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); };
    const emit = (name: string, payload: any) => {
      if (name === "routing:rpc:launch") launches++;
      if (name === "routing:rpc:status") { statuses++; queueMicrotask(() => [...(listeners.get(`${name}:reply:${payload.requestId}`) ?? [])].forEach((handler) => handler({ success: true, data: { handle: "rt-live", state: "running" } }))); }
      for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
    };
    const lifecycle = new Map<string, Function>(); const pi: any = {
      registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      on: (name: string, handler: Function) => lifecycle.set(name, handler), events: { on, emit },
    };
    const ctx: any = { mode: "print", hasUI: false, cwd: root, isProjectTrusted: () => true, ui: { notify: () => {}, setWidget: () => {} }, sessionManager: { getSessionId: () => "session-1", getSessionDir: () => join(root, "session"), getBranch: () => [{ type: "custom", customType: "workflow-run-v1", data: run }] } };
    workflowEngine(pi);
    await lifecycle.get("session_start")?.({ reason: "resume" }, ctx);
    expect(statuses).toBe(1); expect(launches).toBe(0);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});
