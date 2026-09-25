import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { classifyDelegation, classifyModelRoute, type Route, type RouteName, type RoutingDecision, type ThinkingLevel } from "./policy.ts";
import { normalizeTaskOwner, type TaskHandle, type TaskOwner } from "./state.ts";
import { classifyWithJev } from "./jev.ts";
import { launchHerdrAgent, type HerdrLaunch, type RoutedWorkerCapability } from "./herdr.ts";
import { ExplicitRouteRetryGuard, inferPhase, normalizeOwnedPaths, validateWorkflowLaunch, type TaskPhase } from "./workflow.ts";

export interface RoutedTaskLaunchParams {
  task: string;
  description: string;
  route?: string;
  effort?: ThinkingLevel;
  cwd?: string;
  phase?: TaskPhase;
  depends_on?: string[];
  owned_paths?: string[];
  pane_retention?: "keep" | "close";
  capabilities?: RoutedWorkerCapability[];
  /** background: long-lived, never marked complete on idle, and never wakes the primary. */
  mode?: "task" | "background";
  owner?: TaskOwner;
}

export interface LaunchRoutePlan { route: string; config: Route; fallbackFrom?: RouteName }
export interface RoutedTaskLaunchResult { text: string; details: Record<string, unknown>; task?: TaskHandle }

export interface LaunchDependencies {
  pi: ExtensionAPI;
  taskHandles: Map<string, TaskHandle>;
  workflowLaunches: Map<string, Promise<RoutedTaskLaunchResult>>;
  routeRetryGuard: ExplicitRouteRetryGuard;
  recordDecision: (task: string, decision: RoutingDecision) => void;
  resolveRoute: (ctx: ExtensionContext, requested: string, explicit: boolean, effort?: ThinkingLevel) => LaunchRoutePlan;
  trackTask: (task: TaskHandle) => void;
  watchHerdrTask: (task: TaskHandle) => void;
  manifestPath?: string;
}

const newHandle = () => `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const MAX_TASK_LENGTH = 20_000;
const MAX_ARRAY_ITEMS = 32;
const MAX_PATH_LENGTH = 4_096;

export function validateRoutedTaskLaunchParams(input: RoutedTaskLaunchParams): void {
  if (!input || typeof input !== "object") throw new Error("launch params are required");
  if (typeof input.task !== "string" || !input.task.trim()) throw new Error("task is required");
  if (input.task.length > MAX_TASK_LENGTH) throw new Error(`task exceeds the ${MAX_TASK_LENGTH} character limit`);
  if (typeof input.description !== "string" || !input.description.trim()) throw new Error("description is required");
  if (input.description.length > 80) throw new Error("description exceeds the 80 character limit");
  if ((input as any).surface !== undefined) throw new Error("surface is no longer supported; subagents always run in Herdr");
  if ((input as any).isolation !== undefined) throw new Error("isolation is no longer supported; pass an existing worktree as cwd");
  if (input.route !== undefined && (typeof input.route !== "string" || !input.route.trim())) throw new Error("route must be a non-empty model or route name");
  if (input.effort !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.effort)) throw new Error(`unknown effort level ${String(input.effort)}`);
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length > MAX_PATH_LENGTH)) throw new Error("cwd is invalid or exceeds its limit");
  if (input.phase !== undefined && !["plan", "implement", "review", "other"].includes(input.phase)) throw new Error(`unknown workflow phase ${String(input.phase)}`);
  for (const [name, value] of [["depends_on", input.depends_on], ["owned_paths", input.owned_paths]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || value.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_PATH_LENGTH))) throw new Error(`${name} must contain at most ${MAX_ARRAY_ITEMS} bounded strings`);
  }
  if (input.pane_retention !== undefined && input.pane_retention !== "keep" && input.pane_retention !== "close") throw new Error("pane_retention must be keep or close");
  if (input.mode !== undefined && input.mode !== "task" && input.mode !== "background") throw new Error("mode must be task or background");
  if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.some((capability) => capability !== "memory"))) throw new Error("capabilities must contain only memory");
}

const ownerKey = (owner?: TaskOwner): string | undefined => owner?.kind === "workflow" ? `workflow:${owner.runId}:${owner.stepId}:${owner.attemptId}`
  : owner?.kind === "pr" ? `pr:${owner.key}:${owner.signature}` : undefined;

async function launchRoutedTaskOnce(deps: LaunchDependencies, ctx: ExtensionContext, input: RoutedTaskLaunchParams, owner?: unknown): Promise<RoutedTaskLaunchResult> {
  validateRoutedTaskLaunchParams(input);
  const params = { ...input, owner: normalizeTaskOwner(owner ?? input.owner) };
  const task = params.task.trim();
  const description = params.description.trim();
  const brief = `${description}\n${task}`;
  const phase = inferPhase(brief, params.phase);
  const localDecision = classifyDelegation(brief, phase);
  const decision = params.route === undefined ? await classifyWithJev(brief, phase, localDecision) : localDecision;
  deps.recordDecision(task, decision);
  const requestedRoute = params.route?.trim() ?? classifyModelRoute(task, decision);
  const cwd = resolve(params.cwd ?? ctx.cwd);
  const background = params.mode === "background";
  const dependsOn = params.depends_on ?? [];
  const ownedPaths = normalizeOwnedPaths(cwd, params.owned_paths ?? []);
  validateWorkflowLaunch({ cwd, dependsOn, ownedPaths, tasks: deps.taskHandles.values() });

  const retryKey = `${cwd}\n${description}\n${task}`;
  deps.routeRetryGuard.assertAllowed(retryKey, params.route !== undefined);
  let routePlan: LaunchRoutePlan;
  try { routePlan = deps.resolveRoute(ctx, requestedRoute, params.route !== undefined, params.effort); }
  catch (error) { if (params.route !== undefined) deps.routeRetryGuard.record(retryKey, requestedRoute); throw error; }
  deps.routeRetryGuard.clear(retryKey);

  const active = [...deps.taskHandles.values()].filter((item) => !item.background && ["queued", "running", "blocked", "interrupted"].includes(item.state)).length;
  if (active >= 4) throw new Error("Herdr subagent concurrency limit reached (4 active tasks)");
  const routeName = routePlan.route;
  const route = routePlan.config;
  const launched: HerdrLaunch = await launchHerdrAgent(deps.pi, task, description, routeName, route, cwd, undefined, deps.manifestPath, params.capabilities, background);
  const handle = newHandle();
  const tracked: TaskHandle = {
    handle, route: routeName, fallbackFrom: routePlan.fallbackFrom, routeExplicit: params.route !== undefined,
    target: "herdr", model: `${route.provider}/${route.model}`, thinking: route.thinking, label: description,
    cwd, phase, dependsOn, ownedPaths, owner: params.owner, background: background || undefined, state: "running", startedAt: Date.now(),
    agentName: launched.agent, paneId: launched.paneId, tabId: launched.tabId, messageToken: randomUUID(), paneRetention: params.pane_retention ?? "keep",
    transitions: 0, notifiedStates: [], usageOffset: 0, estimatedCost: 0, costKnown: false,
  };
  deps.trackTask(tracked);
  deps.watchHerdrTask(tracked);
  const policyNote = params.route === undefined ? ` Policy selected ${routeName}: ${decision.rationale}` : "";
  const fallbackNote = routePlan.fallbackFrom ? ` Policy fallback: ${routePlan.fallbackFrom} was unavailable, so ${routeName} was selected.` : "";
  return {
    text: `Launched Herdr ${phase} task ${handle}: agent ${launched.agent}, pane ${launched.paneId}, using ${route.provider}/${route.model} (${route.thinking}). The model is fixed. ${background ? "Background subagent: it never reports back; pull its latest output with subagent_control action=result." : "Do not poll; completion will wake the primary."}${policyNote}${fallbackNote}`,
    details: { handle, phase, background, dependsOn, ownedPaths, capabilities: params.capabilities, ...launched, fallbackFrom: routePlan.fallbackFrom, model: `${route.provider}/${route.model}`, thinking: route.thinking, decision, owner: params.owner },
    task: tracked,
  };
}

export async function launchRoutedTask(deps: LaunchDependencies, ctx: ExtensionContext, input: RoutedTaskLaunchParams, owner?: unknown): Promise<RoutedTaskLaunchResult> {
  validateRoutedTaskLaunchParams(input);
  const normalizedOwner = normalizeTaskOwner(owner ?? input.owner);
  const key = ownerKey(normalizedOwner);
  if (!key) return launchRoutedTaskOnce(deps, ctx, input, normalizedOwner);
  const existingTracked = [...deps.taskHandles.values()].find((task) => task.owner && ownerKey(task.owner) === key);
  if (existingTracked) return { text: `Owned subagent ${existingTracked.handle} already exists; returning the existing handle.`,  details: { handle: existingTracked.handle, owner: normalizedOwner, coalesced: true }, task: existingTracked };
  const existing = deps.workflowLaunches.get(key);
  if (existing) return existing;
  const pending = launchRoutedTaskOnce(deps, ctx, { ...input, owner: normalizedOwner }, normalizedOwner);
  deps.workflowLaunches.set(key, pending);
  try { return await pending; }
  finally { if (deps.workflowLaunches.get(key) === pending) deps.workflowLaunches.delete(key); }
}
