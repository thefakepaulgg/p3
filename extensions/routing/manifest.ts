import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskHandle } from "./state.ts";

export const ROUTING_MANIFEST_VERSION = "pi-routing/v1" as const;

export interface ManifestTask {
  handle: string;
  label: string;
  agentName: string;
  paneId: string;
  tabId?: string;
  route: string;
  model: string;
  state: string;
  startedAt: number;
  endedAt?: number;
  sessionPath?: string;
  estimatedCost?: number;
  costKnown?: boolean;
  paneRetention?: "keep" | "close";
  paneClosedAt?: number;
  clearedAt?: number;
}

export interface RoutingManifest {
  version: typeof ROUTING_MANIFEST_VERSION;
  parentSessionId: string;
  parentPaneId: string;
  parentSessionPath?: string;
  primaryCost?: number;
  primaryCostKnown?: boolean;
  sessionTotal?: number;
  sessionTotalKnown?: boolean;
  updatedAt: number;
  tasks: ManifestTask[];
}

export const manifestPathForSession = (sessionDir: string, sessionId: string) =>
  join(sessionDir, `routing-${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

export function taskManifestRecord(task: TaskHandle): ManifestTask | undefined {
  if (!task.agentName || !task.paneId) return undefined;
  return {
    handle: task.handle, label: task.label, agentName: task.agentName, paneId: task.paneId, tabId: task.tabId,
    route: task.route, model: task.model, state: task.state, startedAt: task.startedAt, endedAt: task.endedAt,
    sessionPath: task.sessionPath, estimatedCost: task.estimatedCost, costKnown: task.costKnown,
    paneRetention: task.paneRetention, paneClosedAt: task.paneClosedAt, clearedAt: task.clearedAt,
  };
}

export function writeRoutingManifest(path: string, manifest: RoutingManifest): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temp, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function readRoutingManifest(path: string | undefined): RoutingManifest | undefined {
  if (!path) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RoutingManifest;
    if (value.version !== ROUTING_MANIFEST_VERSION || !value.parentPaneId || !Array.isArray(value.tasks)) return undefined;
    return value;
  } catch { return undefined; }
}

export function removeRoutingManifest(path: string | undefined): void {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* best effort on shutdown */ }
}
