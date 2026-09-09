import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type AdvisorThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AdvisorConfig {
  enabled: boolean;
  model: string;
  fallbackModels: string[];
  contextTokenBudget: number;
  maxOutputTokens: number;
  maxCallsPerRun: number;
  timeoutMs: number;
  thinkingLevel: AdvisorThinkingLevel;
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: true,
  model: "anthropic/claude-fable-5-1",
  fallbackModels: ["openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol"],
  contextTokenBudget: 20_000,
  maxOutputTokens: 12_000,
  maxCallsPerRun: 2,
  timeoutMs: 120_000,
  thinkingLevel: "high",
};

const THINKING_LEVELS = new Set<AdvisorThinkingLevel>(["minimal", "low", "medium", "high", "xhigh"]);

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number, field: string, warnings: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (value !== undefined) warnings.push(`${field} must be a finite number; using ${fallback}`);
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < minimum || rounded > maximum) {
    warnings.push(`${field} must be between ${minimum} and ${maximum}; using ${fallback}`);
    return fallback;
  }
  return rounded;
}

export function parseModelRef(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function parseAdvisorConfig(value: unknown): { config: AdvisorConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (value !== undefined) warnings.push("advisor config must be a JSON object; using defaults");
    return { config: { ...DEFAULT_ADVISOR_CONFIG, fallbackModels: [...DEFAULT_ADVISOR_CONFIG.fallbackModels] }, warnings };
  }

  const input = value as Record<string, unknown>;
  const model = typeof input.model === "string" && parseModelRef(input.model)
    ? input.model
    : DEFAULT_ADVISOR_CONFIG.model;
  if (input.model !== undefined && model === DEFAULT_ADVISOR_CONFIG.model && input.model !== model) {
    warnings.push(`model must use provider/model syntax; using ${model}`);
  }

  const fallbackModels = Array.isArray(input.fallbackModels)
    ? input.fallbackModels.filter((item): item is string => typeof item === "string" && parseModelRef(item) !== undefined)
    : [...DEFAULT_ADVISOR_CONFIG.fallbackModels];
  if (input.fallbackModels !== undefined && !Array.isArray(input.fallbackModels)) {
    warnings.push("fallbackModels must be an array; using defaults");
  }

  const thinkingLevel = typeof input.thinkingLevel === "string" && THINKING_LEVELS.has(input.thinkingLevel as AdvisorThinkingLevel)
    ? input.thinkingLevel as AdvisorThinkingLevel
    : DEFAULT_ADVISOR_CONFIG.thinkingLevel;
  if (input.thinkingLevel !== undefined && thinkingLevel !== input.thinkingLevel) {
    warnings.push(`thinkingLevel is invalid; using ${thinkingLevel}`);
  }

  return {
    config: {
      enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_ADVISOR_CONFIG.enabled,
      model,
      fallbackModels,
      contextTokenBudget: boundedNumber(input.contextTokenBudget, DEFAULT_ADVISOR_CONFIG.contextTokenBudget, 4_000, 100_000, "contextTokenBudget", warnings),
      maxOutputTokens: boundedNumber(input.maxOutputTokens, DEFAULT_ADVISOR_CONFIG.maxOutputTokens, 256, 16_000, "maxOutputTokens", warnings),
      maxCallsPerRun: boundedNumber(input.maxCallsPerRun, DEFAULT_ADVISOR_CONFIG.maxCallsPerRun, 1, 4, "maxCallsPerRun", warnings),
      timeoutMs: boundedNumber(input.timeoutMs, DEFAULT_ADVISOR_CONFIG.timeoutMs, 10_000, 600_000, "timeoutMs", warnings),
      thinkingLevel,
    },
    warnings,
  };
}

export function loadAdvisorConfig(path: string): { config: AdvisorConfig; warnings: string[] } {
  if (!existsSync(path)) return parseAdvisorConfig(undefined);
  try {
    return parseAdvisorConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const parsed = parseAdvisorConfig(undefined);
    parsed.warnings.push(`failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return parsed;
  }
}

export function saveAdvisorConfig(path: string, config: AdvisorConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
