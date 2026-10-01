import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouteName, RoutingDecision } from "./policy.ts";
import type { TaskPhase } from "./workflow.ts";

const MAX_BRIEF_CHARS = 6_000;

export async function getJevModel(ctx: ExtensionContext, signal: AbortSignal) {
  const models = await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe", { signal });
  const jev = models.find((model) => model.provider === "typesafe" && model.id === "jev-latest");
  if (jev) return jev;
  const cloudflareModels = await ctx.modelRegistry.getAvailableOfType("classifier", "cloudflare-workers-ai", { signal });
  return cloudflareModels.find((model) => model.provider === "cloudflare-workers-ai" && model.id === "typesafe/jev");
}

const MIN_CONFIDENCE: Record<RouteName, number> = { sol: 0.6, opus: 0.7, luna: 0.8 };

/**
 * Ask Jev to pick Sol, Opus, or Luna for a launch without an explicit route. Luna is never
 * accepted for planning or implementation. Low confidence or any failure keeps the local decision.
 */
export async function classifyWithJev(brief: string, phase: TaskPhase, local: RoutingDecision, ctx: ExtensionContext): Promise<RoutingDecision> {
  try {
    const signal = AbortSignal.timeout(5_000);
    const model = await getJevModel(ctx, signal);
    if (!model) return local;
    const result = await ctx.modelRegistry.classify(model, {
      state: { phase, brief: brief.slice(0, MAX_BRIEF_CHARS) },
      questions: {
        model: {
          type: "choice",
          instructions: "Which model should run this delegated coding-agent task?",
          criteria: {
            sol: "Default strong model. General implementation, refactors, backend and infrastructure work, planning, design decisions, and judgment calls.",
            opus: "Premium model: more intelligent and faster than sol, but more expensive. Deep or elusive bugs (crashes, races, hangs, regressions, root-cause analysis) and UI work (visual design, layout, animation, SwiftUI/web front-end).",
            luna: "Cheap model. Clearly mechanical, read-only or lightweight work with an objectively checkable result: locating code, listing references, re-running checks, simple re-reviews against explicit criteria.",
          },
        },
      },
    }, { signal, timeoutMs: 5_000, maxRetries: 0 });
    const answer = result.answers.model;
    if (result.stopReason !== "stop" || answer?.type !== "choice") return local;
    const { choice: target, confidence } = answer;
    if (target !== "sol" && target !== "opus" && target !== "luna") return local;
    if (target === "luna" && (phase === "plan" || phase === "implement")) return local;
    if (confidence < MIN_CONFIDENCE[target]) return local;
    return { target, delegate: true, confidence: confidence >= 0.8 ? "high" : "medium", rationale: `Jev selected ${target} (confidence ${confidence.toFixed(2)}).` };
  } catch {
    return local;
  }
}
