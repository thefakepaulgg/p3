import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import routing from "../model-routing.ts";
import { setHerdrTestTransportForTests } from "./herdr.ts";

const envNames = ["PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HC_TERMINAL_ID"] as const;
let previousEnv: Record<string, string | undefined>;
let temp: string;
let server: Server | undefined;
let childPane: string;
beforeEach(() => {
  previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  delete process.env.HC_TERMINAL_ID;
  temp = mkdtempSync(join(tmpdir(), "p3-peer-model-"));
  childPane = `peer-${randomUUID()}`;
  Object.assign(process.env, { PI_CODING_AGENT_DIR: temp, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "parent-workspace", HERDR_PANE_ID: "parent-pane", HERDR_SOCKET_PATH: join(temp, "herdr.sock") });
  setHerdrTestTransportForTests(async (pi, args, timeout) => {
    const result = await pi.exec("herdr", args, { timeout });
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  });
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  setHerdrTestTransportForTests();
  rmSync(join(tmpdir(), `pi-peer-links-${process.getuid?.() ?? "local"}`, `child-${createHash("sha256").update(childPane).digest("hex")}.json`), { force: true });
  rmSync(temp, { recursive: true, force: true });
  for (const key of envNames) {
    if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  }
});

const fixture = async (alreadyOpen = false) => {
  const socketCalls: string[] = [];
  server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]);
      socketCalls.push(request.method);
      const result = request.method === "worktree.list" ? { source: { repo_root: temp } }
        : { workspace: { workspace_id: "peer-workspace" }, root_pane: { pane_id: childPane }, worktree: { path: temp }, already_open: alreadyOpen };
      socket.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(process.env.HERDR_SOCKET_PATH!, resolve); });
  const tools: any[] = [];
  const calls: string[][] = [];
  const sessionPath = join(temp, "peer.jsonl");
  const fake: any = {
    registerVirtualModel: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {}, on: () => {},
    appendEntry: () => {}, sendMessage: () => {}, getThinkingLevel: () => "high",
    events: { on: () => () => {}, emit: () => {} },
    exec: async (command: string, args: string[]) => {
      calls.push(args);
      const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
      if (command === "git") return { code: 0, stdout: args.includes("rev-parse") ? temp : "feature", stderr: "" };
      const key = args.slice(0, 2).join(" ");
      if (key === "agent start") writeFileSync(sessionPath, JSON.stringify({ type: "session", id: args[args.indexOf("--session-id") + 1] }) + "\n");
      if (key === "tab create") return ok({ root_pane: { pane_id: childPane } });
      if (key === "agent get") return ok({ agent: { pane_id: args[2] === "parent-pane" ? "parent-pane" : childPane,
        agent: "pi", terminal_id: `terminal-${args[2]}`, interactive_ready: true, agent_session: { value: sessionPath } } });
      return ok({});
    },
  };
  routing(fake);
  const models = [
    { provider: "anthropic", id: "claude-opus-5-5", name: "Opus", reasoning: true },
    { provider: "custom", id: "exact-model", name: "Exact", reasoning: false },
  ];
  const ctx: any = { cwd: temp, model: { provider: "parent", id: "inherited" }, modelRegistry: {
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models, hasConfiguredAuth: () => true,
  } };
  const tool = tools.find((tool) => tool.name === "workspace_agent");
  const launch = (params: object) => tool.execute("launch", { action: "create", branch: "feature", task: "Implement task", description: "Peer", ...params }, undefined, undefined, ctx);
  return { tool, launch, calls, socketCalls, ctx, models };
};

for (const [action, model, expected, thinking] of [
  ["create", undefined, "parent/inherited", "high"],
  ["open", undefined, "parent/inherited", "high"],
  ["create", "opus", "anthropic/claude-opus-5-5", "medium"],
  ["open", "custom/exact-model", "custom/exact-model", "off"],
  ["create", "exact-model", "custom/exact-model", "off"],
] as const) {
  test(`workspace_agent ${action} launches ${model ?? "inherited model"}`, async () => {
    const f = await fixture(action === "open");
    expect(f.tool.parameters.properties.model.type).toBe("string");
    expect(f.tool.parameters.required).not.toContain("model");
    const result = await f.launch({ action, ...(model ? { model } : {}) });
    expect(result.isError).not.toBe(true);
    expect(f.socketCalls).toEqual(["worktree.list", `worktree.${action}`]);
    const starts = f.calls.filter((args) => args[0] === "agent" && args[1] === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0][starts[0].indexOf("--model") + 1]).toBe(expected);
    expect(starts[0][starts[0].indexOf("--thinking") + 1]).toBe(thinking);
    expect(starts[0]).not.toContain("--resume");
  });
}

test("workspace_agent without a current model preserves Pi defaults", async () => {
  const f = await fixture(); delete f.ctx.model;
  expect((await f.launch({})).isError).not.toBe(true);
  const start = f.calls.find((args) => args[0] === "agent" && args[1] === "start")!;
  expect(start).not.toContain("--model"); expect(start).not.toContain("--thinking");
});

for (const kind of ["unavailable", "ambiguous", "unauthenticated"] as const) {
  test(`workspace_agent rejects ${kind} selection before placement without fallback`, async () => {
    const f = await fixture();
    if (kind === "ambiguous") f.models.push({ ...f.models[1], provider: "other" });
    if (kind === "unauthenticated") f.ctx.modelRegistry.hasConfiguredAuth = () => false;
    const result = await f.launch({ model: kind === "unavailable" ? "missing" : "exact-model" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(kind === "unavailable" ? "Model unavailable" : kind === "ambiguous" ? "ambiguous" : "No credentials");
    expect(f.socketCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
}
