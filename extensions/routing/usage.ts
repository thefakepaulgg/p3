import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface UsageCursor {
  sessionPath?: string;
  offset: number;
  cost: number;
  costKnown: boolean;
}

export interface UsageRead extends UsageCursor {
  changed: boolean;
}

const messageCost = (entry: any): number | undefined => {
  const message = entry?.type === "message" ? entry.message : undefined;
  const total = message?.usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : undefined;
};

/** Read complete newly appended JSONL records without consuming a partial trailing line. */
export function readIncrementalUsage(path: string | undefined, previous: UsageCursor): UsageRead {
  if (!path) return { ...previous, changed: false };
  let offset = previous.sessionPath === path ? previous.offset : 0;
  let cost = previous.sessionPath === path ? previous.cost : 0;
  let costKnown = previous.sessionPath === path ? previous.costKnown : false;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size < offset) { offset = 0; cost = 0; costKnown = false; }
    if (size === offset) return { sessionPath: path, offset, cost, costKnown, changed: previous.sessionPath !== path };
    const buffer = Buffer.alloc(size - offset);
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    const chunk = buffer.subarray(0, bytes);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return { sessionPath: path, offset, cost, costKnown, changed: previous.sessionPath !== path };
    const complete = chunk.subarray(0, lastNewline + 1).toString("utf8");
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = messageCost(JSON.parse(line));
        if (value !== undefined) { cost += value; costKnown = true; }
      } catch { /* malformed complete records do not disturb the cursor or totals */ }
    }
    const nextOffset = offset + lastNewline + 1;
    return { sessionPath: path, offset: nextOffset, cost, costKnown, changed: nextOffset !== previous.offset || cost !== previous.cost || costKnown !== previous.costKnown || path !== previous.sessionPath };
  } catch {
    return { ...previous, changed: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function sumSessionCost(entries: Iterable<any>): { cost: number; known: boolean } {
  let cost = 0;
  let known = false;
  for (const entry of entries) {
    const value = messageCost(entry);
    if (value !== undefined) { cost += value; known = true; }
  }
  return { cost, known };
}

export function formatEstimatedCost(cost: number | undefined, known = cost !== undefined): string | undefined {
  if (!known || cost === undefined || !Number.isFinite(cost)) return undefined;
  const digits = cost < 0.01 ? 4 : 2;
  return `~$${cost.toFixed(digits)}`;
}
