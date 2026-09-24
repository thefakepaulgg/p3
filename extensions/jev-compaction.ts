import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { typesafeApiKey } from "./routing/jev.ts";

const MAX_CANDIDATES = 40;
const SCORE_CHARS = 1_500;
const KEEP_PROBABILITY = 0.7;
const RETAINED_BUDGET_CHARS = 8_000;
const RETAINED_ITEM_CHARS = 2_000;

interface Candidate {
  tool: string;
  isError: boolean;
  text: string;
}

function resultText(message: ToolResultMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
}

/**
 * Jev-assisted compaction. Pi's own summary still runs; Jev only picks which tool outputs
 * being compacted away are worth carrying forward near-verbatim, because the default summarizer
 * truncates tool results and paraphrases exact values. Any failure falls back to default compaction.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (typesafeApiKey()) ctx.ui.setStatus("jev", "jev: ready");
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const apiKey = typesafeApiKey();
    const model = ctx.model;
    if (!apiKey || !model) return;

    const { preparation, customInstructions, signal } = event;
    const candidates: Candidate[] = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, isError: message.isError, text: resultText(message) }))
      .filter((candidate) => candidate.text)
      .slice(-MAX_CANDIDATES);
    if (candidates.length === 0) return;

    try {
      const { TypeSafeClient, noul } = await import("@typesafe-ai/sdk");
      const jev = new TypeSafeClient({ apiKey, timeout: 15_000, retry: { maxRetries: 0 }, logLevel: "off" });
      const questions = Object.fromEntries(candidates.map((_, id) => [
        `keep_${id}`,
        noul(`Should tool output ${id} be carried forward verbatim after this history is summarized? Yes only if it holds errors, failing test output, exact values, identifiers, or constraints that a prose summary would lose and that cannot cheaply be re-obtained by re-running the tool.`),
      ]));
      const { answers } = await jev.systemOne({
        state: {
          goal: customInstructions ?? "Continue the ongoing coding task.",
          previousSummary: preparation.previousSummary?.slice(0, 4_000) ?? null,
          outputs: candidates.map((candidate, id) => ({ id, tool: candidate.tool, isError: candidate.isError, text: candidate.text.slice(0, SCORE_CHARS) })),
        },
        questions,
      }, { signal });

      // Highest-probability outputs win the budget; they are then shown in original order.
      let budget = RETAINED_BUDGET_CHARS;
      const kept = candidates
        .map((candidate, id) => ({ ...candidate, id, probability: answers[`keep_${id}`]?.noul ?? 0 }))
        .filter((candidate) => candidate.probability >= KEEP_PROBABILITY)
        .sort((a, b) => b.probability - a.probability)
        .filter((candidate) => {
          const size = Math.min(candidate.text.length, RETAINED_ITEM_CHARS);
          if (size > budget) return false;
          budget -= size;
          return true;
        })
        .sort((a, b) => a.id - b.id);

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return;
      const result = await compact(preparation, model, auth.apiKey, auth.headers, customInstructions, signal, pi.getThinkingLevel(), undefined, auth.env);
      ctx.ui.setStatus("jev", `jev: compact kept ${kept.length}/${candidates.length} outputs`);
      if (kept.length === 0) return { compaction: result };

      const retained = kept.map((candidate) => {
        const text = candidate.text.length > RETAINED_ITEM_CHARS ? `${candidate.text.slice(0, RETAINED_ITEM_CHARS)}\n[truncated]` : candidate.text;
        return `### ${candidate.tool}${candidate.isError ? " (error)" : ""}\n\`\`\`\n${text}\n\`\`\``;
      }).join("\n\n");
      return { compaction: { ...result, summary: `${result.summary}\n\n## Retained Tool Output (selected by Jev)\n\n${retained}` } };
    } catch {
      return;
    }
  });
}
