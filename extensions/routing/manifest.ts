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
  messageToken?: string;
  route: TaskHandle["route"];
  fallbackFrom?: TaskHandle["fallbackFrom"];
  routeExplicit?: boolean;
  target?: string;
  model: string;
  thinking?: TaskHandle["thinking"];
  state: TaskHandle["state"];
  startedAt: number;
  endedAt?: number;
  cwd?: string;
  phase?: TaskHandle["phase"];
  dependsOn?: string[];
  ownedPaths?: string[];
  owner?: TaskHandle["owner"];
  background?: boolean;
  sessionPath?: string;
  usageOffset?: number;
  estimatedCost?: number;
  costKnown?: boolean;
  paneRetention?: "keep" | "close";
  paneClosedAt?: number;
  clearedAt?: number;
  transitions?: number;
  notifiedStates?: string[];
  completionNotifiedAt?: number;
  completionDeliveredVia?: TaskHandle["completionDeliveredVia"];
}

export interface RoutingManifest {
  version: typeof ROUTING_MANIFEST_VERSION;
  parentSessionId: string;
  parentPaneId: string;
  parentInbox?: string;
  parentSessionPath?: string;
  primaryCost?: number;
  primaryCostKnown?: boolean;
  sessionTotal?: number;
  sessionTotalKnown?: boolean;
  updatedAt: number;
  tasks: ManifestTask[];
}

export const manifestPathForPane = (sessionDir: string, paneId: string) =>
  join(sessionDir, `routing-pane-${paneId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

export function restoreTaskHandle(task: ManifestTask): TaskHandle {
  return {
    handle: task.handle, label: task.label, agentName: task.agentName, paneId: task.paneId, tabId: task.tabId, messageToken: task.messageToken,
    route: task.route, fallbackFrom: task.fallbackFrom, routeExplicit: task.routeExplicit ?? false,
    target: task.target ?? "herdr", model: task.model, thinking: task.thinking ?? "medium",
    state: task.state, startedAt: task.startedAt, endedAt: task.endedAt, cwd: task.cwd, phase: task.phase,
    dependsOn: task.dependsOn, ownedPaths: task.ownedPaths, owner: task.owner, background: task.background,
    sessionPath: task.sessionPath, usageOffset: task.usageOffset, estimatedCost: task.estimatedCost, costKnown: task.costKnown,
    paneRetention: task.paneRetention, paneClosedAt: task.paneClosedAt, clearedAt: task.clearedAt,
    transitions: task.transitions ?? 0, notifiedStates: task.notifiedStates ?? [],
    completionNotifiedAt: task.completionNotifiedAt, completionDeliveredVia: task.completionDeliveredVia,
  };
}

export function taskManifestRecord(task: TaskHandle): ManifestTask | undefined {
  if (!task.agentName || !task.paneId) return undefined;
  return {
    handle: task.handle, label: task.label, agentName: task.agentName, paneId: task.paneId, tabId: task.tabId, messageToken: task.messageToken,
    route: task.route, fallbackFrom: task.fallbackFrom, routeExplicit: task.routeExplicit, target: task.target,
    model: task.model, thinking: task.thinking, state: task.state, startedAt: task.startedAt, endedAt: task.endedAt,
    cwd: task.cwd, phase: task.phase, dependsOn: task.dependsOn, ownedPaths: task.ownedPaths,
    owner: task.owner, background: task.background, sessionPath: task.sessionPath, usageOffset: task.usageOffset,
    estimatedCost: task.estimatedCost, costKnown: task.costKnown, paneRetention: task.paneRetention,
    paneClosedAt: task.paneClosedAt, clearedAt: task.clearedAt, transitions: task.transitions,
    notifiedStates: task.notifiedStates, completionNotifiedAt: task.completionNotifiedAt,
    completionDeliveredVia: task.completionDeliveredVia,
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
