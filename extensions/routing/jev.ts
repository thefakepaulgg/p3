import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RouteName, RoutingDecision } from "./policy.ts";
import type { TaskPhase } from "./workflow.ts";

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

const MIN_CONFIDENCE: Record<RouteName, number> = { sol: 0.6, opus: 0.7, luna: 0.8 };

/**
 * Ask Jev to pick Sol, Opus, or Luna for a launch without an explicit route. Luna is never
 * accepted for planning or implementation. Low confidence or any failure keeps the local decision.
 */
export async function classifyWithJev(brief: string, phase: TaskPhase, local: RoutingDecision, apiKey = typesafeApiKey()): Promise<RoutingDecision> {
  if (!apiKey) return local;
  try {
    const { TypeSafeClient, choice } = await import("@typesafe-ai/sdk");
    const client = new TypeSafeClient({ apiKey, timeout: 5_000, retry: { maxRetries: 0 }, logLevel: "off" });
    const { answers } = await client.systemOne({
      state: { phase, brief: brief.slice(0, MAX_BRIEF_CHARS) },
      questions: {
        model: choice("Which model should run this delegated coding-agent task?", {
          sol: "Default strong model. General implementation, refactors, backend and infrastructure work, planning, design decisions, and judgment calls.",
          opus: "Premium model: more intelligent and faster than sol, but more expensive. Deep or elusive bugs (crashes, races, hangs, regressions, root-cause analysis) and UI work (visual design, layout, animation, SwiftUI/web front-end).",
          luna: "Cheap model. Clearly mechanical, read-only or lightweight work with an objectively checkable result: locating code, listing references, re-running checks, simple re-reviews against explicit criteria.",
        }),
      },
    });
    const { choice: target, confidence } = answers.model;
    if (target === "luna" && (phase === "plan" || phase === "implement")) return local;
    if (confidence < MIN_CONFIDENCE[target]) return local;
    return { target, delegate: true, confidence: confidence >= 0.8 ? "high" : "medium", rationale: `Jev selected ${target} (confidence ${confidence.toFixed(2)}).` };
  } catch {
    return local;
  }
}
