import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompletionOptions, createAdvisorExtension, getAdvisorCost } from "../advisor.ts";
import { DEFAULT_ADVISOR_CONFIG } from "./config.ts";

let temp: string | undefined;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

function configPath(overrides: Record<string, unknown> = {}): string {
  temp = mkdtempSync(join(tmpdir(), "advisor-ext-"));
  const path = join(temp, "advisor.json");
  writeFileSync(path, JSON.stringify({
    enabled: true,
    model: "anthropic/claude-fable-5-1",
    fallbackModels: ["openai/gpt-5.6-sol"],
    contextTokenBudget: 4_000,
    maxOutputTokens: 1_000,
    maxCallsPerRun: 2,
    timeoutMs: 30_000,
    thinkingLevel: "high",
    ...overrides,
  }));
  return path;
}

const advisorUsage = {
  input: 2_000,
  output: 500,
  cacheRead: 1_000,
  cacheWrite: 0,
  totalTokens: 3_500,
  cost: {
    input: 0.03,
    output: 0.0375,
    cacheRead: 0.001,
    cacheWrite: 0,
    total: 0.0685,
  },
};

const advisorModel: any = {
  provider: "anthropic",
  id: "claude-fable-5-1",
  name: "Claude Fable 5.1",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function sessionEntry(text: string): any {
  return {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

function setup(path: string) {
  const tools: any[] = [];
  const commands: any[] = [];
  const handlers = new Map<string, Function>();
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  const completions: any[] = [];
  const fakePi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) => commands.push({ name, command }),
    on: (event: string, handler: Function) => handlers.set(event, handler),
  };
  createAdvisorExtension({ configPath: path })(fakePi);
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    model: { provider: "openai", id: "gpt-5.6-luna" },
    modelRegistry: {
      find: (provider: string, modelId: string) => provider === advisorModel.provider && modelId === advisorModel.id ? advisorModel : undefined,
      hasConfiguredAuth: (model: any) => model === advisorModel,
      complete: async (model: any, context: any, options: any) => {
        completions.push({ model, context, options });
        return {
          role: "assistant",
          content: [{ type: "text", text: "Recommendation: keep the bounded design." }],
          stopReason: "stop",
          usage: advisorUsage,
          provider: model.provider,
          model: model.id,
          api: model.api,
          timestamp: Date.now(),
        };
      },
    },
    sessionManager: {
      buildContextEntries: () => [sessionEntry("Use API_KEY=do-not-send and preserve behavior")],
      getEntries: () => [],
      getSessionId: () => "session-1",
    },
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
    },
  };
  return { tools, commands, handlers, statuses, notifications, completions, ctx };
}

const request = {
  stage: "planning",
  question: "Should the context packet stay bounded?",
  decision: "Use a compaction-aware recent window capped at 20k tokens.",
  constraints: ["Do not replay the uncompressed full conversation"],
  alternatives: ["Send the full transcript"],
  evidence: ["The user rejected uncompressed replay", "token=request-secret", "API_KEY=request-upper-secret"],
};

test("maps reasoning options for OpenAI fallback models", () => {
  const options = buildCompletionOptions(
    { ...advisorModel, provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" },
    DEFAULT_ADVISOR_CONFIG,
    undefined,
    "session-1:advisor",
  );
  expect(options.reasoningEffort).toBe("high");
  expect(options.thinkingEnabled).toBeUndefined();
  expect(options.reasoning).toBeUndefined();
});

test("registers the advisor tool and command", () => {
  const state = setup(configPath());
  expect(state.tools.map((tool) => tool.name)).toEqual(["advisor"]);
  expect(state.commands.map((command) => command.name)).toEqual(["advisor"]);
});

test("consults a cross-provider model with bounded redacted context", async () => {
  const state = setup(configPath());
  state.handlers.get("agent_start")?.({});
  const result = await state.tools[0].execute("call-1", request, undefined, undefined, state.ctx);
  expect(result.content[0].text).toContain("keep the bounded design");
  expect(state.completions).toHaveLength(1);
  expect(state.completions[0].model).toBe(advisorModel);
  const prompt = state.completions[0].context.messages[0].content[0].text;
  expect(prompt).toContain("Should the context packet stay bounded?");
  expect(prompt).toContain("preserve behavior");
  expect(prompt).not.toContain("do-not-send");
  expect(prompt).not.toContain("request-secret");
  expect(prompt).not.toContain("request-upper-secret");
  expect(() => JSON.parse(prompt.slice(prompt.indexOf("\n") + 1))).not.toThrow();
  expect(Math.ceil(prompt.length / 3)).toBeLessThanOrEqual(4_000);
  expect(state.completions[0].options.maxTokens).toBe(1_000);
  expect(state.completions[0].options.thinkingEnabled).toBe(true);
  expect(state.completions[0].options.effort).toBe("high");
  expect(state.completions[0].options.reasoning).toBeUndefined();
  expect(state.completions[0].options.timeoutMs).toBe(30_000);
  expect(result.details.estimatedInputTokens).toBeLessThan(5_000);
  expect(result.details.cost).toBe(0.0685);
  expect(result.usage).toEqual(advisorUsage);
  expect(result.content[0].text).toContain("$0.069");
  expect(state.statuses.at(-1)).toBe("advisor:claude-fable-5-1 · $0.069");
});

test("bounds oversized request fields before provider transfer", async () => {
  const state = setup(configPath());
  const result = await state.tools[0].execute(
    "call-1",
    { ...request, evidence: ["E".repeat(4_000_000)] },
    undefined,
    undefined,
    state.ctx,
  );
  const prompt = state.completions[0].context.messages[0].content[0].text;
  expect(Math.ceil(prompt.length / 3)).toBeLessThanOrEqual(4_000);
  expect(result.details.requestTruncated).toBe(true);
});

test("normalizes malformed legacy message content instead of crashing", async () => {
  const state = setup(configPath());
  state.ctx.sessionManager.buildContextEntries = () => [{
    ...sessionEntry("ignored"),
    message: { role: "assistant", content: null, timestamp: Date.now() },
  }];
  const result = await state.tools[0].execute("call-1", request, undefined, undefined, state.ctx);
  expect(result.content[0].text).toContain("keep the bounded design");
  expect(state.completions).toHaveLength(1);
});

test("enforces the configured per-run consultation limit", async () => {
  const state = setup(configPath({ maxCallsPerRun: 1 }));
  state.handlers.get("agent_start")?.({});
  await state.tools[0].execute("call-1", request, undefined, undefined, state.ctx);
  const blocked = await state.tools[0].execute("call-2", { ...request, followUp: true }, undefined, undefined, state.ctx);
  expect(state.completions).toHaveLength(1);
  expect(blocked.content[0].text).toContain("call limit reached");
});

test("counts advisor usage separately and restores it from the session", () => {
  const priorEntries = [
    {
      type: "message",
      message: { role: "toolResult", toolName: "advisor", usage: advisorUsage },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "another-tool",
        usage: { ...advisorUsage, cost: { ...advisorUsage.cost, total: 99 } },
      },
    },
  ];
  expect(getAdvisorCost(priorEntries)).toBe(0.0685);

  const state = setup(configPath());
  state.ctx.sessionManager.getEntries = () => priorEntries;
  state.handlers.get("session_start")?.({}, state.ctx);
  expect(state.statuses.at(-1)).toBe("advisor:claude-fable-5-1 · $0.069");
});

test("reports advisor cost through the status command", async () => {
  const state = setup(configPath());
  await state.tools[0].execute("call-1", request, undefined, undefined, state.ctx);
  await state.commands[0].command.handler("status", state.ctx);
  expect(state.notifications.at(-1)).toContain("cost=$0.069");
});

test("retains billable usage when the advisor response is an error", async () => {
  const state = setup(configPath());
  state.ctx.modelRegistry.complete = async (model: any) => ({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "provider failed after generation",
    usage: advisorUsage,
    provider: model.provider,
    model: model.id,
    api: model.api,
    timestamp: Date.now(),
  });
  const result = await state.tools[0].execute("call-1", request, undefined, undefined, state.ctx);
  expect(result.content[0].text).toContain("failed · $0.069");
  expect(result.usage).toEqual(advisorUsage);
  expect(result.details.cost).toBe(0.0685);
  expect(state.statuses.at(-1)).toBe("advisor:claude-fable-5-1 · $0.069");
});

test("supports session-scoped off and persistent model controls", async () => {
  const path = configPath({ model: "openai/gpt-5.6-sol" });
  const state = setup(path);
  const command = state.commands[0].command;
  await command.handler("off", state.ctx);
  await command.handler("model anthropic/claude-fable-5-1", state.ctx);
  const blocked = await state.tools[0].execute("call-1", request, undefined, undefined, state.ctx);
  expect(blocked.content[0].text).toContain("disabled");
  expect(state.notifications.at(-1)).toContain("disabled");
  expect(JSON.parse(readFileSync(path, "utf8")).model).toBe("anthropic/claude-opus-5");

  const nextSession = setup(path);
  nextSession.handlers.get("session_start")?.({}, nextSession.ctx);
  expect(nextSession.statuses.at(-1)).toBe("advisor:claude-opus-5");
});
