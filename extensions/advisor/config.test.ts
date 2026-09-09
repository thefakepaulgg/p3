import { expect, test } from "bun:test";
import { DEFAULT_ADVISOR_CONFIG, parseAdvisorConfig, parseModelRef } from "./config.ts";

test("parses provider/model references", () => {
  expect(parseModelRef("anthropic/claude-fable-5-1")).toEqual({ provider: "anthropic", modelId: "claude-fable-5-1" });
  expect(parseModelRef("missing-slash")).toBeUndefined();
  expect(parseModelRef("/missing-provider")).toBeUndefined();
});

test("uses safe bounded defaults for malformed configuration", () => {
  const { config, warnings } = parseAdvisorConfig({
    model: "bad",
    fallbackModels: "not-an-array",
    contextTokenBudget: 999,
    maxOutputTokens: 999_999,
    maxCallsPerRun: 0,
    thinkingLevel: "extreme",
  });
  expect(config).toEqual(DEFAULT_ADVISOR_CONFIG);
  expect(warnings.length).toBeGreaterThanOrEqual(5);
});

test("accepts a configured cross-provider advisor and bounded budgets", () => {
  const { config, warnings } = parseAdvisorConfig({
    enabled: false,
    model: "anthropic/claude-fable-5-1",
    fallbackModels: ["openai/gpt-5.6-sol", "invalid"],
    contextTokenBudget: 16_000,
    maxOutputTokens: 2_000,
    maxCallsPerRun: 1,
    timeoutMs: 45_000,
    thinkingLevel: "xhigh",
  });
  expect(warnings).toEqual([]);
  expect(config.enabled).toBe(false);
  expect(config.fallbackModels).toEqual(["openai/gpt-5.6-sol"]);
  expect(config.contextTokenBudget).toBe(16_000);
  expect(config.timeoutMs).toBe(45_000);
  expect(config.thinkingLevel).toBe("xhigh");
});
