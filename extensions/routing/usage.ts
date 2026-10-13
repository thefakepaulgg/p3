import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ThinkingLevel } from "./policy.ts";

export interface UsageCursor {
  sessionPath?: string;
  offset: number;
  cost: number;
  costKnown: boolean;
  complete?: boolean;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface UsageRead extends UsageCursor {
  changed: boolean;
}

const messageCost = (entry: any): number | undefined => {
  const message = entry?.type === "message" ? entry.message : undefined;
  if (message?.role !== "assistant") return undefined;
  const total = message.usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
};

/** Read complete newly appended JSONL records without consuming a partial trailing line. */
export function readIncrementalUsage(path: string | undefined, previous: UsageCursor): UsageRead {
  if (!path) return { ...previous, complete: false, changed: previous.complete !== false };
  const sameSession = previous.sessionPath === path;
  let offset = sameSession ? previous.offset : 0;
  let cost = sameSession ? previous.cost : 0;
  let costKnown = sameSession ? previous.costKnown : false;
  let complete = sameSession ? previous.complete ?? true : true;
  let model = sameSession ? previous.model : undefined;
  let thinking = sameSession ? previous.thinking : undefined;
  const result = (): UsageRead => ({
    sessionPath: path, offset, cost, costKnown, complete, model, thinking,
    changed: offset !== previous.offset || cost !== previous.cost || costKnown !== previous.costKnown
      || complete !== previous.complete || path !== previous.sessionPath || model !== previous.model || thinking !== previous.thinking,
  });
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size < offset) { offset = 0; cost = 0; costKnown = false; complete = true; model = undefined; thinking = undefined; }
    if (size === offset) {
      if (complete) costKnown = true;
      return result();
    }
    const buffer = Buffer.alloc(size - offset);
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    const chunk = buffer.subarray(0, bytes);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return result();
    const records = chunk.subarray(0, lastNewline + 1).toString("utf8");
    for (const line of records.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const message = entry?.type === "message" ? entry.message : undefined;
        if (message?.role === "assistant") {
          const value = messageCost(entry);
          if (value !== undefined) { cost += value; costKnown = true; }
          else complete = false;
          if (typeof message.provider === "string" && typeof message.model === "string") model = `${message.provider}/${message.model}`;
          const effort = message.thinkingLevel ?? message.providerThinkingLevel;
          if (["off", "minimal", "low", "medium", "high"].includes(effort)) thinking = effort;
        }
      } catch { complete = false; }
    }
    offset += lastNewline + 1;
    if (bytes !== buffer.length) complete = false;
    if (complete) costKnown = true;
    return result();
  } catch {
    complete = false;
    return result();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function sumSessionCost(entries: Iterable<any>): { cost: number; known: boolean; complete: boolean } {
  let cost = 0;
  let known = false;
  let complete = true;
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const value = messageCost(entry);
    if (value !== undefined) { cost += value; known = true; }
    else complete = false;
  }
  return { cost, known: known || complete, complete };
}

/** Account only for the primary session and its routed task slices, not independent peers. */
export function aggregateUsageCoverage(
  primary: { cost: number; known: boolean; complete: boolean },
  tasks: Iterable<{
    handle?: string;
    sessionPath?: string;
    usageStartOffset?: number;
    usageOffset?: number;
    estimatedCost?: number;
    costKnown?: boolean;
    costComplete?: boolean;
  }>,
): { cost: number; known: boolean; complete: boolean; missingSources: number; scope: "session+routed" } {
  let known = primary.known && Number.isFinite(primary.cost) && primary.cost >= 0;
  let cost = known ? primary.cost : 0;
  let complete = known && primary.complete;
  let missingSources = complete ? 0 : 1;
  const windows = new Map<string, Array<{ start: number; end: number }>>();
  for (const task of tasks) {
    const start = task.usageStartOffset;
    const end = task.usageOffset;
    const validWindow = !!task.sessionPath && Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && start! >= 0 && end! >= start!;
    const previous = task.sessionPath ? windows.get(task.sessionPath) ?? [] : [];
    const overlap = validWindow && previous.some(window => start! < window.end && end! > window.start);
    if (validWindow) {
      previous.push({ start: start!, end: end! });
      windows.set(task.sessionPath!, previous);
    }
    const proven = validWindow && !overlap && task.costKnown === true
      && typeof task.estimatedCost === "number" && Number.isFinite(task.estimatedCost) && task.estimatedCost >= 0
      && (start !== end || task.estimatedCost === 0);
    if (proven) { cost += task.estimatedCost!; known = true; }
    if (!proven || task.costComplete !== true) { complete = false; missingSources++; }
  }
  return { cost, known, complete, missingSources, scope: "session+routed" };
}

export function formatEstimatedCost(cost: number | undefined, known = cost !== undefined): string | undefined {
  if (!known || cost === undefined || !Number.isFinite(cost)) return undefined;
  const digits = cost < 0.01 ? 4 : 2;
  return `~$${cost.toFixed(digits)}`;
}
