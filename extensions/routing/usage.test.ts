import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateUsageCoverage, formatEstimatedCost, readIncrementalUsage, sumSessionCost } from "./usage.ts";

const message = (cost?: number, role = "assistant") => JSON.stringify({ type: "message", message: { role, usage: cost === undefined ? {} : { cost: { total: cost } } } });

test("incrementally sums session cost without double counting", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  writeFileSync(path, `${message(0.004)}\n`);
  const first = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(first.cost).toBe(0.004);
  expect(readIncrementalUsage(path, first).cost).toBe(0.004);
  appendFileSync(path, `${message(0.006)}\n`);
  expect(readIncrementalUsage(path, first).cost).toBe(0.01);
});

test("leaves a partial JSONL tail unread until it is complete", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  writeFileSync(path, message(0.003));
  const partial = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(partial.offset).toBe(0);
  expect(partial.costKnown).toBe(false);
  appendFileSync(path, "\n");
  expect(readIncrementalUsage(path, partial).cost).toBe(0.003);
});

test("non-assistant records do not incur session cost", () => {
  expect(sumSessionCost([
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
    { type: "message", message: { role: "toolResult", usage: { cost: { total: 0.2 } } } },
    { type: "message", message: { role: "user" } },
  ])).toEqual({ cost: 0.5, known: true, complete: true });
});

test("omits unknown pricing and retains precision below one cent", () => {
  expect(sumSessionCost([{ type: "message", message: { role: "assistant", usage: {} } }])).toEqual({ cost: 0, known: false, complete: false });
  expect(formatEstimatedCost(0, false)).toBeUndefined();
  expect(formatEstimatedCost(0.0042, true)).toBe("~$0.0042");
  expect(formatEstimatedCost(1.234, true)).toBe("~$1.23");
});

test("tracks dispatched physical model and effort across provider failover", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  const record = (provider: string, model: string, thinkingLevel: string) => JSON.stringify({ type: "message", message: { role: "assistant", provider, model, thinkingLevel, usage: {} } });
  writeFileSync(path, `${record("openai-codex", "gpt-6-luna", "high")}\n`);
  const first = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(first.model).toBe("openai-codex/gpt-6-luna");
  expect(first.thinking).toBe("high");
  appendFileSync(path, `${record("anthropic", "claude-haiku-5-5", "medium")}\n`);
  const switched = readIncrementalUsage(path, first);
  expect(switched.model).toBe("anthropic/claude-haiku-5-5");
  expect(switched.thinking).toBe("medium");
  expect(readIncrementalUsage(path, switched).model).toBe(switched.model);
});

test("zero-priced assistant turns and no assistant turns are known complete zero", () => {
  expect(sumSessionCost([])).toEqual({ cost: 0, known: true, complete: true });
  expect(sumSessionCost([JSON.parse(message(0))])).toEqual({ cost: 0, known: true, complete: true });
  expect(sumSessionCost([JSON.parse(message(undefined, "user"))])).toEqual({ cost: 0, known: true, complete: true });
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  writeFileSync(path, "");
  const empty = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(empty).toMatchObject({ cost: 0, costKnown: true, complete: true });
  appendFileSync(path, `${message(0)}\n`);
  expect(readIncrementalUsage(path, empty)).toMatchObject({ cost: 0, costKnown: true, complete: true });
});

test("missing or invalid assistant charges retain proven cost but make coverage incomplete", () => {
  for (const invalid of [undefined, -1, NaN, Infinity, "0"]) {
    expect(sumSessionCost([
      JSON.parse(message(0.2)),
      { type: "message", message: { role: "assistant", usage: { cost: { total: invalid } } } },
    ])).toEqual({ cost: 0.2, known: true, complete: false });
  }
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  writeFileSync(path, `${message()}\n`);
  const missing = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(missing).toMatchObject({ cost: 0, costKnown: false, complete: false });
  appendFileSync(path, `${message(0.2)}\n`);
  const charged = readIncrementalUsage(path, missing);
  expect(charged).toMatchObject({ cost: 0.2, costKnown: true, complete: false });
  expect(readIncrementalUsage(path, charged).complete).toBe(false);
});

test("unavailable sources are incomplete without losing already known cost", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  const initial = { offset: 0, cost: 0, costKnown: false };
  expect(readIncrementalUsage(path, initial)).toMatchObject({ cost: 0, costKnown: false, complete: false });
  expect(readIncrementalUsage(undefined, initial)).toMatchObject({ costKnown: false, complete: false });
  writeFileSync(path, `${message(0.2)}\n`);
  const charged = readIncrementalUsage(path, initial);
  unlinkSync(path);
  expect(readIncrementalUsage(path, charged)).toMatchObject({ offset: charged.offset, cost: 0.2, costKnown: true, complete: false });
  expect(readIncrementalUsage(undefined, charged)).toMatchObject({ cost: 0.2, costKnown: true, complete: false });
});

test("truncation and new sessions reset incomplete coverage and previous totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-usage-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${message(0.2)}\n${message()}\n`);
  const previous = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(previous.complete).toBe(false);
  writeFileSync(path, `${message(0)}\n`);
  expect(readIncrementalUsage(path, previous)).toMatchObject({ cost: 0, costKnown: true, complete: true, changed: true });
  writeFileSync(path, "");
  expect(readIncrementalUsage(path, previous)).toMatchObject({ offset: 0, cost: 0, costKnown: true, complete: true });
  writeFileSync(path, `${message()}\n`);
  expect(readIncrementalUsage(path, previous)).toMatchObject({ cost: 0, costKnown: false, complete: false });
  const nextPath = join(dir, "next.jsonl");
  writeFileSync(nextPath, `${message(0.1)}\n`);
  expect(readIncrementalUsage(nextPath, previous)).toMatchObject({ cost: 0.1, costKnown: true, complete: true });
});

const primaryUsage = { cost: 1, known: true, complete: true };
const slice = (start: number, end: number, cost: number) => ({
  sessionPath: "/routed/session.jsonl", usageStartOffset: start, usageOffset: end,
  estimatedCost: cost, costKnown: true, costComplete: true,
});

test("aggregate coverage includes disjoint same-session continuations", () => {
  expect(aggregateUsageCoverage(primaryUsage, [slice(0, 100, 0.2), slice(100, 200, 0.3)]))
    .toEqual({ cost: 1.5, known: true, complete: true, missingSources: 0, scope: "session+routed" });
  expect(aggregateUsageCoverage({ cost: 0, known: true, complete: true }, [slice(0, 0, 0)]))
    .toEqual({ cost: 0, known: true, complete: true, missingSources: 0, scope: "session+routed" });
});

test("aggregate coverage excludes overlapping and duplicate slices", () => {
  expect(aggregateUsageCoverage(primaryUsage, [slice(0, 100, 0.2), slice(0, 100, 0.2)]))
    .toEqual({ cost: 1.2, known: true, complete: false, missingSources: 1, scope: "session+routed" });
  expect(aggregateUsageCoverage(primaryUsage, [slice(0, 100, 0.2), slice(50, 150, 0.3)]))
    .toEqual({ cost: 1.2, known: true, complete: false, missingSources: 1, scope: "session+routed" });
});

test("aggregate coverage reports unknown and unverifiable sources rather than adding zero", () => {
  expect(aggregateUsageCoverage(primaryUsage, [
    { handle: "unknown", costKnown: false },
    { estimatedCost: 0.3, costKnown: true, costComplete: true },
    { ...slice(0, 100, 0.2), costComplete: false },
    { ...slice(100, 200, 0.3), usageStartOffset: undefined },
  ])).toEqual({ cost: 1.2, known: true, complete: false, missingSources: 4, scope: "session+routed" });
  expect(aggregateUsageCoverage({ cost: 0, known: false, complete: false }, []))
    .toEqual({ cost: 0, known: false, complete: false, missingSources: 1, scope: "session+routed" });
  expect(aggregateUsageCoverage({ cost: 0, known: false, complete: false }, [slice(0, 100, 0.2)]))
    .toEqual({ cost: 0.2, known: true, complete: false, missingSources: 1, scope: "session+routed" });
});
