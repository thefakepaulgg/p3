import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { buildContextPacket, redactSensitiveText, serializeMessage } from "./context.ts";

const user = (text: string, timestamp = Date.now()): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistant = (text: string, timestamp = Date.now()): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp,
});

test("redacts common credential forms before advisor transfer", () => {
  const value = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "API_KEY=super-secret-value",
    "password: hunter2-value",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "glpat-abcdefghijklmnopqrstuvwxyz",
    "AccountKey=storage-account-secret",
    "SharedAccessKey=shared-access-secret",
    "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
    "AIzaabcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
    "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
  ].join("\n");
  const redacted = redactSensitiveText(value);
  expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(redacted).not.toContain("super-secret-value");
  expect(redacted).not.toContain("hunter2-value");
  expect(redacted).not.toContain("storage-account-secret");
  expect(redacted).not.toContain("private-key-material");
  expect(redacted).toContain("[REDACTED");
});

test("omits private reasoning while retaining assistant text", () => {
  const message = assistant("visible") as any;
  message.content.push({ type: "thinking", thinking: "private chain" });
  const serialized = serializeMessage(message);
  expect(serialized).toContain("visible");
  expect(serialized).not.toContain("private chain");
  expect(serialized).toContain("omits private reasoning");
});

test("builds a bounded layered packet with summary and newest evidence", () => {
  const messages: Message[] = [
    user("The conversation history before this point was compacted into the following summary:\n\n<summary>Original requirement: preserve API behavior.</summary>"),
    ...Array.from({ length: 40 }, (_, index) => assistant(`old-${index} ${"x".repeat(300)}`, index)),
    user("LATEST_EVIDENCE: focused tests pass"),
  ];
  const result = buildContextPacket(messages, 1_000);
  expect(result.packet.length).toBeLessThanOrEqual(3_000);
  expect(result.packet).toContain("<historical_summary>");
  expect(result.packet).toContain("preserve API behavior");
  expect(result.packet).toContain("LATEST_EVIDENCE");
  expect(result.messagesOmitted).toBeGreaterThan(0);
  expect(result.truncated).toBe(true);
});

test("does not mistake quoted summary tags for compaction metadata", () => {
  const result = buildContextPacket([user("A file contains <summary>literal text</summary>"), assistant("continue")], 4_000);
  expect(result.packet).not.toContain("<historical_summary>");
  expect(result.packet).toContain("literal text");
});

test("tolerates missing legacy message content", () => {
  const malformed = assistant("ignored") as any;
  malformed.content = null;
  expect(() => buildContextPacket([malformed], 4_000)).not.toThrow();
});

test("uses the whole recent transcript when it fits", () => {
  const result = buildContextPacket([user("constraint"), assistant("decision")], 4_000);
  expect(result.packet).toContain("constraint");
  expect(result.packet).toContain("decision");
  expect(result.messagesIncluded).toBe(2);
  expect(result.messagesOmitted).toBe(0);
  expect(result.truncated).toBe(false);
});
