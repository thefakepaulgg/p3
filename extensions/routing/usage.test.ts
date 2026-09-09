import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatEstimatedCost, readIncrementalUsage, sumSessionCost } from "./usage.ts";

const message = (cost?: number, role = "assistant") => JSON.stringify({ type: "message", message: { role, usage: cost === undefined ? {} : { cost: { total: cost } } } });

test("incrementally sums session cost without double counting", () => {
  const path = join(mkdtempSync(join(tmpdir(), "routing-usage-")), "session.jsonl");
  writeFileSync(path, `${message(0.004)}\n`);
  const first = readIncrementalUsage(path, { offset: 0, cost: 0, costKnown: false });
  expect(first.cost).toBe(0.004);
  expect(readIncrementalUsage(path, first).cost).toBe(0.004);
  appendFileSync(path, `${message(0.006, "toolResult")}\n`);
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

test("includes model-backed tool result cost in the session total", () => {
  expect(sumSessionCost([
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
    { type: "message", message: { role: "toolResult", usage: { cost: { total: 0.2 } } } },
  ])).toEqual({ cost: 0.7, known: true });
});

test("omits unknown pricing and retains precision below one cent", () => {
  expect(sumSessionCost([{ type: "message", message: { role: "assistant", usage: {} } }])).toEqual({ cost: 0, known: false });
  expect(formatEstimatedCost(0, false)).toBeUndefined();
  expect(formatEstimatedCost(0.0042, true)).toBe("~$0.0042");
  expect(formatEstimatedCost(1.234, true)).toBe("~$1.23");
});
