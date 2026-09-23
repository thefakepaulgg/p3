import { inferPhase, type TaskPhase } from "./workflow.ts";

export type RouteName = "sol" | "luna" | "opus";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DelegationTarget = RouteName;

export interface Route {
  label: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  purpose: string;
}

export interface RoutingDecision {
  target: DelegationTarget;
  delegate: boolean;
  confidence: "high" | "medium";
  rationale: string;
}

export const routes: Record<RouteName, Route> = {
  sol: { label: "Sol", provider: "openai-codex", model: "gpt-6-sol", thinking: "medium", purpose: "Ambiguous, consequential, or difficult reasoning and implementation" },
  luna: { label: "Luna", provider: "openai-codex", model: "gpt-6-luna", thinking: "high", purpose: "Predictable, mechanical, objectively verifiable work" },
  opus: { label: "Opus", provider: "anthropic", model: "claude-opus-5-5", thinking: "medium", purpose: "Deep bugs and UI work; smarter and faster than Sol but more expensive" },
};

export const fallbackChains: Record<RouteName, RouteName[]> = {
  sol: ["sol"],
  luna: ["luna", "sol"],
  opus: ["opus", "sol"],
};

const has = (text: string, pattern: RegExp) => pattern.test(text);
// Keep these narrow: broad words such as "docs" or "verify with" appear in almost every brief and sent implementation to Luna.
const mechanicalWork = /\b(mechanical|rename|regenerate|generated (types|client|code)|boilerplate|from (the |a )?template|seed data|find|locate|search for|where is|which files?|callers?|list|collect|extract)\b/;
const deepBugWork = /\b(debug|diagnos(e|is|ing)|root[- ]cause|crash(es|ing)?|race condition|deadlock|memory leak|leaks?|flaky|hangs?|hanging|heisenbug|regression|intermittent)\b/;
const uiWork = /\b(ui|ux|swiftui|uikit|layout|animation|animate|visual|screens?|styling|css|typography|design system|mockups?|components?)\b/;
const difficultWork = /\b(ambiguous|architecture|architectural|design|high[- ]consequence|high[- ]risk|production decision|destructive|hard to reverse|security[- ]critical|incident|difficult|complex|trade[- ]offs?|migration plan|implementation plan|accepted plan|parallel plan)\b/;

/** Sol by default. Opus for deep bugs and UI work. Luna only for clearly mechanical review/discovery work; never for planning or implementation. */
export function classifyDelegation(task: string, phase: TaskPhase = inferPhase(task)): RoutingDecision {
  const text = task.toLowerCase();
  if (has(text, /\b(accepted plan|parallel plan|parallel execution)\b/)) return { target: "sol", delegate: true, confidence: "high", rationale: "Parallel execution of an accepted plan is appropriate for a Sol agent." };
  if (has(text, deepBugWork)) return { target: "opus", delegate: true, confidence: "medium", rationale: "Deep debugging goes to Opus." };
  if (has(text, uiWork) && phase !== "review") return { target: "opus", delegate: true, confidence: "medium", rationale: "UI work goes to Opus." };
  if (has(text, difficultWork)) return { target: "sol", delegate: false, confidence: "high", rationale: "Difficult, ambiguous, or consequential work stays with Sol unless it is deliberately routed." };
  if (phase === "plan" || phase === "implement") return { target: "sol", delegate: true, confidence: "high", rationale: "Planning and implementation go to Sol." };
  if (has(text, mechanicalWork) && !has(text, /\b(decide|design|implement|refactor|migrate)\b/)) return { target: "luna", delegate: true, confidence: "medium", rationale: "Mechanical review or discovery with a checkable result is suitable for Luna." };
  return { target: "sol", delegate: true, confidence: "medium", rationale: "Luna is reserved for clearly mechanical work; uncertain work goes to Sol." };
}

export function classifyModelRoute(task: string, decision = classifyDelegation(task)): RouteName {
  return decision.target;
}

export function planFallback(requested: RouteName, explicit: boolean, isAvailable: (route: RouteName) => boolean): { route: RouteName; fallbackFrom?: RouteName } | { error: string } {
  if (explicit) return isAvailable(requested) ? { route: requested } : { error: `Explicit route ${requested} is unavailable; no fallback was applied` };
  for (const candidate of fallbackChains[requested]) if (isAvailable(candidate)) return candidate === requested ? { route: candidate } : { route: candidate, fallbackFrom: requested };
  return { error: `No available model route. Tried: ${fallbackChains[requested].join(", ")}` };
}
