import type { RouteName, ThinkingLevel } from "./policy.ts";
import type { TaskPhase } from "./workflow.ts";
import { formatEstimatedCost } from "./usage.ts";

/** interrupted: the user pressed Esc in the pane mid-task; the agent is idle but the task is unfinished and still watched. */
export type TaskState = "queued" | "running" | "blocked" | "interrupted" | "completed" | "failed" | "stopped" | "abandoned";

/** Bounded correlation metadata supplied by workflow callers over routing RPC. */
export type TaskOwner = { kind: "workflow"; runId: string; stepId: string; attemptId: string }
  | { kind: "pr"; key: string; signature: string };

export interface TaskHandle {
  handle: string;
  route: string;
  fallbackFrom?: RouteName;
  routeExplicit: boolean;
  target: string;
  model: string;
  thinking: ThinkingLevel;
  label: string;
  cwd?: string;
  phase?: TaskPhase;
  dependsOn?: string[];
  ownedPaths?: string[];
  /** Optional workflow correlation; persisted in telemetry but never used for routing policy. */
  owner?: TaskOwner;
  /** Long-lived subagent that never completes on idle and never notifies the primary. */
  background?: boolean;
  state: TaskState;
  startedAt: number;
  endedAt?: number;
  agentName?: string;
  paneId?: string;
  tabId?: string;
  messageToken?: string;
  paneRetention?: "keep" | "close";
  paneClosedAt?: number;
  /** Hides a terminal task from user-facing recent/list surfaces while preserving its durable record. */
  clearedAt?: number;
  toolUses?: number;
  tokens?: number;
  resultChars?: number;
  sessionPath?: string;
  usageOffset?: number;
  estimatedCost?: number;
  costKnown?: boolean;
  /** Full worker result, cached in memory only. Never persisted to telemetry. */
  result?: string;
  error?: string;
  escalation?: string;
  transitions: number;
  /** Delivered notification kinds. Content-independent so dedup survives result changes. */
  notifiedStates: string[];
  /** Set once the current run's completion message has been delivered or consumed manually. */
  completionNotifiedAt?: number;
  completionDeliveredVia?: CompletionDelivery;
  blockedEpisodes?: number;
  interruptedEpisodes?: number;
}

export type CompletionDelivery = "message" | "manual";

/** Notification kind for the single bounded completion message. */
export const COMPLETION_KIND = "completed";
/** Maximum characters of worker output quoted inside the completion message. */
export const COMPLETION_EXCERPT_LIMIT = 600;
/** Hard cap on any routed-task custom message body. */
export const NOTIFICATION_LIMIT = 1200;
/** Maximum retained notification kinds per task. */
export const NOTIFIED_KIND_LIMIT = 12;
export const ROUTING_RPC_VERSION = 1;

/** Keep cross-extension correlation bounded before it reaches telemetry or lifecycle events. */
export function normalizeTaskOwner(owner: unknown): TaskOwner | undefined {
  if (!owner || typeof owner !== "object") return undefined;
  const candidate = owner as Record<string, unknown>;
  if (candidate.kind !== "workflow" && candidate.kind !== "pr") throw new Error("owner.kind must be workflow or pr");
  const value = (key: string) => {
    const entry = candidate[key];
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`owner.${key} must be a non-empty string`);
    return entry.trim().slice(0, 128);
  };
  return candidate.kind === "pr"
    ? { kind: "pr", key: value("key"), signature: value("signature") }
    : { kind: "workflow", runId: value("runId"), stepId: value("stepId"), attemptId: value("attemptId") };
}

/** Metadata safe for lifecycle/RPC status channels; never includes the in-memory result. */
const boundedOwner = (owner?: TaskOwner): TaskOwner | undefined => owner?.kind === "pr"
  ? { kind: "pr", key: owner.key.slice(0, 128), signature: owner.signature.slice(0, 128) }
  : owner ? { kind: "workflow", runId: owner.runId.slice(0, 128), stepId: owner.stepId.slice(0, 128), attemptId: owner.attemptId.slice(0, 128) } : undefined;

export function taskMetadata(task: TaskHandle): Record<string, unknown> {
  return {
    handle: task.handle, route: task.route, fallbackFrom: task.fallbackFrom,
    routeExplicit: task.routeExplicit, target: task.target, model: task.model, thinking: task.thinking,
    label: truncate(task.label, 80), cwd: task.cwd, phase: task.phase, dependsOn: task.dependsOn?.slice(0, 32),
    ownedPaths: task.ownedPaths?.slice(0, 20), owner: boundedOwner(task.owner), background: task.background,
    state: task.state, startedAt: task.startedAt, endedAt: task.endedAt,
    agentName: task.agentName, paneId: task.paneId, tabId: task.tabId, paneRetention: task.paneRetention,
    paneClosedAt: task.paneClosedAt, toolUses: task.toolUses, tokens: task.tokens, resultChars: task.resultChars,
    sessionPath: task.sessionPath, estimatedCost: task.estimatedCost, costKnown: task.costKnown,
    error: task.error?.slice(0, 240), escalation: task.escalation?.slice(0, 240),
  };
}

export function recommendEscalation(task: Pick<TaskHandle, "state" | "route" | "fallbackFrom" | "resultChars" | "error">): string | undefined {
  if (task.state === "blocked") return "Steer the Herdr agent with the missing decision or inspect its pane.";
  if (task.state === "interrupted") return "Its output is partial, not a result. Steer it to resume, or stop it.";
  if (task.error && /auth|credential|model|unavailable/i.test(task.error)) return "Resolve model credentials or explicitly select an available route; do not silently substitute an explicit route.";
  if (task.state === "failed" || task.state === "stopped" || task.state === "abandoned") return "Return the evidence to the Sol primary and reassess scope or quality needs.";
  if (task.state === "completed" && (task.resultChars ?? 0) < 40) return "The result is unusually short; verify it before reporting completion.";
  if (task.fallbackFrom) return `Policy fallback used ${task.route} because ${task.fallbackFrom} was unavailable; use an explicit route to forbid substitution.`;
  return undefined;
}

export const truncate = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** Sanitize a notification kind so persisted telemetry can never carry result text. */
export const notificationKind = (kind: string) => (kind.split(/[^A-Za-z0-9#_-]/)[0] || "unknown").slice(0, 24);

export const boundNotification = (content: string) => truncate(content.trim(), NOTIFICATION_LIMIT);

const completionAlreadyClaimed = (kinds: string[]) =>
  kinds.some((kind) => notificationKind(kind) === COMPLETION_KIND);

export const canDeliverCompletion = (task: Pick<TaskHandle, "completionNotifiedAt" | "notifiedStates">) =>
  !task.completionNotifiedAt && !completionAlreadyClaimed(task.notifiedStates ?? []);

/** Claim the current run's completion-delivery slot. Returns false when it was already claimed. */
export function markCompletionDelivered(task: TaskHandle, via: CompletionDelivery, now = Date.now()): boolean {
  if (!canDeliverCompletion(task)) return false;
  task.completionNotifiedAt = now;
  task.completionDeliveredVia = via;
  task.notifiedStates = [...(task.notifiedStates ?? []), COMPLETION_KIND].slice(-NOTIFIED_KIND_LIMIT);
  return true;
}

/** Open a new completion-delivery slot when a completed task is steered to continue. */
export function resetCompletionDelivery(task: TaskHandle): void {
  task.completionNotifiedAt = undefined;
  task.completionDeliveredVia = undefined;
  task.notifiedStates = (task.notifiedStates ?? []).filter((kind) => notificationKind(kind) !== COMPLETION_KIND);
}

/** Claim a non-completion notification kind. Returns false when that kind was already delivered. */
export function markNotified(task: TaskHandle, kind: string): boolean {
  const normalized = notificationKind(kind);
  if ((task.notifiedStates ?? []).some((seen) => notificationKind(seen) === normalized)) return false;
  task.notifiedStates = [...(task.notifiedStates ?? []), normalized].slice(-NOTIFIED_KIND_LIMIT);
  return true;
}

/**
 * Build the one bounded completion message. The full result stays cached in memory and is
 * retrieved on demand through subagent_control, so the message never carries a whole transcript.
 */
export function buildCompletionMessage(task: TaskHandle, result: string): string {
  const body = result.trim();
  const excerpt = truncate(body, COMPLETION_EXCERPT_LIMIT);
  const lines = [`Subagent ${task.handle} completed (${truncate(task.label, 80)}) on ${task.route} ${task.model}.`];
  lines.push(body ? `Excerpt: ${excerpt}` : "No assistant text was captured.");
  lines.push(`Full cached result (${body.length} chars): subagent_control action=result handle=${task.handle}`);
  if (task.fallbackFrom) lines.push(`Fallback: ${task.fallbackFrom} was unavailable; used ${task.route}.`);
  if (task.escalation) lines.push(`Escalation: ${truncate(task.escalation, 240)}`);
  if (task.paneId) lines.push(task.paneClosedAt ? `Pane ${task.paneId} was closed.` : `Pane ${task.paneId} is retained for inspection.`);
  return boundNotification(lines.join("\n"));
}

/** Bounded wake message for a user interrupt; the excerpt is labelled as partial, never as a result. */
export function buildInterruptedMessage(task: TaskHandle, lastOutput: string): string {
  const body = lastOutput.trim();
  const lines = [`Subagent ${task.handle} was interrupted by the user (${truncate(task.label, 80)}) before finishing its task.`];
  if (body) lines.push(`Last partial output: ${truncate(body, COMPLETION_EXCERPT_LIMIT)}`);
  if (task.escalation) lines.push(truncate(task.escalation, 240));
  if (task.paneId) lines.push(`Pane ${task.paneId} is still open and watched; a resumed turn will report completion.`);
  return boundNotification(lines.join("\n"));
}

const ACTIVE_STATES: TaskState[] = ["queued", "running", "blocked", "interrupted"];
export const isActiveTask = (task: Pick<TaskHandle, "state">) => ACTIVE_STATES.includes(task.state);

/** Widget key used for the routed-task status widget. */
export const WIDGET_KEY = "routed-tasks";
export const WIDGET_MAX_ROWS = 4;
export const WIDGET_RECENT_WINDOW_MS = 30 * 60_000;

const STATE_MARKER: Record<TaskState, string> = {
  queued: "○", running: "●", blocked: "◆", interrupted: "‖", completed: "✓", failed: "×", stopped: "−", abandoned: "?",
};

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Human-facing model label: the full model ID without its provider prefix. */
export function formatModelLabel(model: string): string {
  return model.split("/").pop() ?? model;
}

export type TaskWidgetItem = Pick<TaskHandle, "handle" | "background" | "label" | "model" | "state" | "startedAt" | "endedAt" | "estimatedCost" | "costKnown" | "paneId" | "paneClosedAt" | "clearedAt">;

export function formatTaskRow(task: TaskWidgetItem, now: number): string {
  const until = isActiveTask(task) ? now : task.endedAt ?? now;
  const parts = [
    `${STATE_MARKER[task.state] ?? "?"} ${truncate(task.label, 52)}`,
    formatModelLabel(task.model),
    formatElapsed(until - task.startedAt),
  ];
  const cost = formatEstimatedCost(task.estimatedCost, task.costKnown);
  if (cost) parts.push(cost);
  if (task.background && isActiveTask(task)) parts.push("background");
  if (task.state === "blocked") parts.push("needs input");
  else if (task.state === "interrupted") parts.push("interrupted");
  else if (task.state === "failed" || task.state === "abandoned") parts.push(task.state);
  else if (task.paneClosedAt) parts.push("closed");
  return truncate(parts.join(" · "), 120);
}

export function taskWidgetItems(tasks: Iterable<TaskWidgetItem>, now = Date.now(), maxRows = WIDGET_MAX_ROWS): TaskWidgetItem[] {
  const items = [...tasks].filter((task) => !task.clearedAt);
  const active = items.filter(isActiveTask).sort((a, b) => a.startedAt - b.startedAt);
  const recent = items
    .filter((task) => !isActiveTask(task) && now - (task.endedAt ?? task.startedAt) <= WIDGET_RECENT_WINDOW_MS)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return [...active, ...recent].slice(0, Math.max(1, maxRows));
}

/** Compact semantic widget lines; model-routing adds theme colors and a light border. */
export function formatTaskWidget(tasks: Iterable<TaskWidgetItem>, now = Date.now(), maxRows = WIDGET_MAX_ROWS): string[] | undefined {
  const items = [...tasks].filter((task) => !task.clearedAt);
  const active = items.filter(isActiveTask).sort((a, b) => a.startedAt - b.startedAt);
  const recent = items
    .filter((task) => !isActiveTask(task) && now - (task.endedAt ?? task.startedAt) <= WIDGET_RECENT_WINDOW_MS)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  if (!active.length && !recent.length) return undefined;
  const shown = taskWidgetItems(items, now, maxRows);
  const counts = [active.length ? `${active.length} active` : "", recent.length ? `${recent.length} recent` : ""].filter(Boolean).join(" · ");
  const lines = [`Subagents · ${counts}`];
  for (const task of shown) lines.push(formatTaskRow(task, now));
  const hidden = active.length + recent.length - shown.length;
  if (hidden > 0) lines.push(`… ${hidden} more`);
  return lines;
}

export function telemetryRecord(task: TaskHandle): Record<string, unknown> {
  return {
    handle: task.handle, route: task.route, fallbackFrom: task.fallbackFrom,
    routeExplicit: task.routeExplicit, target: task.target, model: task.model, thinking: task.thinking,
    label: task.label.slice(0, 80), cwd: task.cwd, phase: task.phase, dependsOn: task.dependsOn,
    ownedPaths: task.ownedPaths?.slice(0, 20), owner: boundedOwner(task.owner), background: task.background,
    state: task.state, startedAt: task.startedAt, endedAt: task.endedAt,
    agentName: task.agentName, paneId: task.paneId, tabId: task.tabId, paneRetention: task.paneRetention, paneClosedAt: task.paneClosedAt, clearedAt: task.clearedAt, toolUses: task.toolUses,
    tokens: task.tokens, resultChars: task.resultChars, sessionPath: task.sessionPath, usageOffset: task.usageOffset, estimatedCost: task.estimatedCost, costKnown: task.costKnown, error: task.error?.slice(0, 240),
    escalation: task.escalation?.slice(0, 240), transitions: task.transitions,
    notifiedStates: (task.notifiedStates ?? []).slice(-NOTIFIED_KIND_LIMIT).map(notificationKind),
    completionNotifiedAt: task.completionNotifiedAt, completionDeliveredVia: task.completionDeliveredVia,
    blockedEpisodes: task.blockedEpisodes, interruptedEpisodes: task.interruptedEpisodes,
  };
}
