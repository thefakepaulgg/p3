import type { Message } from "@earendil-works/pi-ai";

export interface ContextPacket {
  packet: string;
  estimatedTokens: number;
  messagesIncluded: number;
  messagesOmitted: number;
  truncated: boolean;
}

// Code, JSON, and tool output tokenize more densely than prose. Three chars/token
// intentionally under-fills the configured budget rather than risking overflow.
const CHARS_PER_TOKEN = 3;
const MIN_CONTEXT_TOKENS = 1_000;

export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|github_pat|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GCP_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(
      /((?:api[_-]?key|accountkey|sharedaccesskey|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)\s*["']?\s*[:=]\s*["']?)([^\s,"'};]{3,})/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*([^\s,"'};]+)/g,
      "$1=[REDACTED]",
    );
}

export function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 40) return value.slice(0, Math.max(0, limit));
  const marker = "\n…[truncated]…\n";
  const available = limit - marker.length;
  const head = Math.ceil(available * 0.6);
  return value.slice(0, head) + marker + value.slice(value.length - (available - head));
}

function contentPartToText(part: unknown): string {
  if (!part || typeof part !== "object") return String(part ?? "");
  const item = part as Record<string, unknown>;
  if (item.type === "text") return String(item.text ?? "");
  if (item.type === "thinking") return "[advisor context omits private reasoning]";
  if (item.type === "image") return `[image omitted: ${String(item.mimeType ?? "unknown type")}]`;
  if (item.type === "toolCall") {
    const args = item.arguments === undefined ? "{}" : JSON.stringify(item.arguments);
    return `[tool call: ${String(item.name ?? "unknown")}]\n${args}`;
  }
  return JSON.stringify(item);
}

function messageContentToText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map(contentPartToText).filter(Boolean).join("\n");
}

export function serializeMessage(message: Message): string {
  if (message.role === "toolResult") {
    const outcome = message.isError ? "error" : "success";
    return `[tool result: ${message.toolName}; ${outcome}]\n${messageContentToText(message)}`;
  }
  return `[${message.role}]\n${messageContentToText(message)}`;
}

function isCompactionSummary(serialized: string): boolean {
  const lower = serialized.toLowerCase();
  return lower.includes("conversation history before this point was compacted") || lower.includes("[compactionsummary]");
}

export function buildContextPacket(messages: Message[], tokenBudget: number): ContextPacket {
  const boundedTokens = Math.max(MIN_CONTEXT_TOKENS, Math.floor(tokenBudget));
  const maxChars = boundedTokens * CHARS_PER_TOKEN;
  const serialized = messages.map((message) => redactSensitiveText(serializeMessage(message)));

  const summaryIndex = serialized.findIndex(isCompactionSummary);
  let summary = summaryIndex >= 0 ? serialized[summaryIndex] : "";
  let summaryTruncated = false;
  if (summary) {
    const summaryLimit = Math.floor(maxChars * 0.2);
    if (summary.length > summaryLimit) {
      summary = truncateMiddle(summary, summaryLimit);
      summaryTruncated = true;
    }
  }

  const summaryBlock = summary ? `<historical_summary>\n${summary}\n</historical_summary>\n\n` : "";
  const prefix = `${summaryBlock}<recent_transcript>\n`;
  const suffix = "\n</recent_transcript>";
  let remaining = Math.max(0, maxChars - prefix.length - suffix.length);
  const chosen: string[] = [];
  let included = 0;

  for (let index = serialized.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (index === summaryIndex) continue;
    const separator = chosen.length ? 2 : 0;
    if (remaining <= separator) break;
    let item = serialized[index];
    const available = remaining - separator;
    if (item.length > available) item = truncateMiddle(item, available);
    chosen.push(item);
    included += 1;
    remaining -= item.length + separator;
    if (item.length < serialized[index].length) break;
  }

  chosen.reverse();
  const packet = prefix + (chosen.length ? chosen.join("\n\n") : "[no prior transcript]") + suffix;
  const contextMessageCount = serialized.length - (summaryIndex >= 0 ? 1 : 0);
  const omitted = Math.max(0, contextMessageCount - included);

  return {
    packet,
    estimatedTokens: estimateTextTokens(packet),
    messagesIncluded: included + (summary ? 1 : 0),
    messagesOmitted: omitted,
    truncated: summaryTruncated || omitted > 0,
  };
}
