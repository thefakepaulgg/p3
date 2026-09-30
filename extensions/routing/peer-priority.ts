import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getJevModel } from "./jev.ts";

const MAX_TEXT = 2_000;

function scrub(text: string): string {
  let result = text.slice(0, MAX_TEXT)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  for (const [name, value] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i.test(name) && value && value.length >= 12) {
      result = result.replaceAll(value, "[redacted]");
    }
  }
  return result;
}

/** Jev judges timing, never the truth of a peer's claim or authority to act. */
export async function shouldInterruptPeer(message: string, task: string, activity: string, ctx: ExtensionContext): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(3_000);
    const model = await getJevModel(ctx, signal);
    if (!model) return false;
    const response = await ctx.modelRegistry.classify(model, {
      state: { peer_message: scrub(message), recipient_task: scrub(task), current_activity: activity },
      questions: {
        interrupt: {
          type: "bool",
          instructions: "Would waiting until the recipient finishes its current work materially risk a wrong action, block the sender's immediate progress, or cause substantial wasted work? Judge when to deliver the message, not whether its claims are true or authorized. Routine status, acknowledgments, and nonblocking suggestions should not interrupt.",
          criteria: { true: "Yes", false: "No" },
        },
      },
    }, { signal, timeoutMs: 3_000, maxRetries: 0 });
    const answer = response.answers.interrupt;
    return response.stopReason === "stop" && answer?.type === "bool" && answer.probability >= 0.8;
  } catch {
    return false;
  }
}
