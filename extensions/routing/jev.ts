import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RoutingDecision } from "./policy.ts";
import type { TaskPhase } from "./workflow.ts";

const LUNA_MIN_CONFIDENCE = 0.8;
const MAX_BRIEF_CHARS = 6_000;

/**
 * Same key sources as pi-jev. Jev routing is personal-only: work machines have no key,
 * so absence of a key is what keeps briefs from being sent to TypeSafe.
 */
export function typesafeApiKey(): string | undefined {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  const file = join(homedir(), ".pi", "agent", "secrets", "typesafe_api_key");
  if (!existsSync(file)) return undefined;
  try { return readFileSync(file, "utf8").trim() || undefined; } catch { return undefined; }
}

/**
 * Ask Jev whether a Sol-by-default launch can go to Luna. Only review/other work is asked;
 * planning, implementation, and difficult work keep the local Sol decision without a request.
 * Any failure or low confidence returns the local decision.
 */
export async function classifyWithJev(brief: string, phase: TaskPhase, local: RoutingDecision, apiKey = typesafeApiKey()): Promise<RoutingDecision> {
  if (!apiKey || phase === "plan" || phase === "implement" || local.confidence === "high") return local;
  try {
    const { TypeSafeClient, choice } = await import("@typesafe-ai/sdk");
    const client = new TypeSafeClient({ apiKey, timeout: 5_000, retry: { maxRetries: 0 }, logLevel: "off" });
    const { answers } = await client.systemOne({
      state: { phase, brief: brief.slice(0, MAX_BRIEF_CHARS) },
      questions: {
        model: choice("Which model should run this delegated coding-agent task?", {
          sol: "Strong model. Any implementation, code changes, design, debugging, judgment calls, or work whose result is not mechanically checkable.",
          luna: "Cheap model. Clearly mechanical, read-only or lightweight work with an objectively checkable result: locating code, listing references, re-running checks, simple re-reviews against explicit criteria.",
        }),
      },
    });
    const answer = answers.model;
    if (answer.choice === "luna" && answer.confidence >= LUNA_MIN_CONFIDENCE) {
      return { target: "luna", delegate: true, confidence: "high", rationale: `Jev classified this as mechanical work (confidence ${answer.confidence.toFixed(2)}).` };
    }
    return { target: "sol", delegate: true, confidence: "medium", rationale: `Jev did not confidently classify this as mechanical (${answer.choice}, ${answer.confidence.toFixed(2)}); using Sol.` };
  } catch {
    return local;
  }
}
