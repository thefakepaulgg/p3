import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { classifyDelegation, classifyModelRoute, type CapabilityTier, type Route, type RouteName, type RoutingDecision, type ThinkingLevel } from "./policy.ts";
import { isActiveTask, normalizeTaskOwner, type TaskHandle, type TaskOwner } from "./state.ts";
import { prepareEvidence } from "./evidence.ts";
import { pathForResultRef } from "./artifacts.ts";
import { classifyRoute, routingClassifierConfig } from "./classifier.ts";
import { launchHerdrAgent, type HerdrLaunch, type RoutedWorkerCapability } from "./herdr.ts";
import { validateContinuation, withSessionStartLock } from "./continuation.ts";
import { orchestrationError, OrchestrationError } from "./errors.ts";
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
  files?: string[];
  readonly?: boolean;
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
  resolveRoute: (ctx: ExtensionContext, requested: string, explicit: boolean, effort?: ThinkingLevel, tier?: CapabilityTier) => LaunchRoutePlan;
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
  if (input.effort !== undefined && !["off", "minimal", "low", "medium", "high"].includes(input.effort)) throw new Error(`unsupported effort level ${String(input.effort)}; maximum effort is high`);
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length > MAX_PATH_LENGTH)) throw new Error("cwd is invalid or exceeds its limit");
  if (input.phase !== undefined && !["plan", "implement", "review", "other"].includes(input.phase)) throw new Error(`unknown workflow phase ${String(input.phase)}`);
  for (const [name, value] of [["depends_on", input.depends_on], ["owned_paths", input.owned_paths]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || value.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_PATH_LENGTH))) throw new Error(`${name} must contain at most ${MAX_ARRAY_ITEMS} bounded strings`);
  }
  if (input.pane_retention !== undefined && input.pane_retention !== "keep" && input.pane_retention !== "close") throw new Error("pane_retention must be keep or close");
  if (input.mode !== undefined && input.mode !== "task" && input.mode !== "background") throw new Error("mode must be task or background");
  if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.some((capability) => capability !== "memory"))) throw new Error("capabilities must contain only memory");
  if (input.readonly !== undefined && typeof input.readonly !== "boolean") throw new Error("readonly must be a boolean");
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > MAX_ARRAY_ITEMS || input.files.some((file) => typeof file !== "string" || !file.trim() || file.length > MAX_PATH_LENGTH))) throw new Error("files must contain at most 32 bounded paths or result references");
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
  const decision = params.route === undefined ? await classifyRoute(brief, phase, localDecision, ctx, {}, routingClassifierConfig(deps.pi.getSettings?.())) : localDecision;
  deps.recordDecision(task, decision);
  const requestedRoute = params.route?.trim() ?? classifyModelRoute(task, decision);
  const cwd = resolve(params.cwd ?? ctx.cwd);
  const background = params.mode === "background";
  const evidence = prepareEvidence(params.files, cwd, pathForResultRef);
  const prompt = [task, evidence.text].filter(Boolean).join("\n\n");
  const dependsOn = params.depends_on ?? [];
  const ownedPaths = normalizeOwnedPaths(cwd, params.owned_paths ?? []);
  validateWorkflowLaunch({ cwd, dependsOn, ownedPaths, tasks: deps.taskHandles.values() });

  const retryKey = `${cwd}\n${description}\n${task}`;
  deps.routeRetryGuard.assertAllowed(retryKey, params.route !== undefined);
  let routePlan: LaunchRoutePlan;
  try { routePlan = deps.resolveRoute(ctx, requestedRoute, params.route !== undefined, params.effort, decision.tier); }
  catch (error) { if (params.route !== undefined) deps.routeRetryGuard.record(retryKey, requestedRoute); throw error; }
  deps.routeRetryGuard.clear(retryKey);

  const active = [...deps.taskHandles.values()].filter((item) => !item.background && isActiveTask(item)).length;
  if (active >= 4) throw new Error("Herdr subagent concurrency limit reached (4 active tasks)");
  const routeName = routePlan.route;
  const route = routePlan.config;
  const handle = newHandle();
  const tracked: TaskHandle = {
    handle, assignmentId: randomUUID(), parentSessionId: ctx.sessionManager.getSessionId(), workerManifestPath: deps.manifestPath, minimumGeneration: 1, readonly: params.readonly, capabilities: params.capabilities ?? [],
    route: routeName, fallbackFrom: routePlan.fallbackFrom, routeExplicit: params.route !== undefined,
    target: "herdr", model: `${route.provider}/${route.model}`, thinking: route.thinking, label: description,
    cwd, phase, dependsOn, ownedPaths, owner: params.owner, background: background || undefined, state: "queued", startedAt: Date.now(),
    messageToken: randomUUID(), paneRetention: params.pane_retention ?? (background ? "keep" : "close"),
    transitions: 0, notifiedStates: [], usageStartOffset: 0, usageOffset: 0, estimatedCost: 0, costKnown: false, costComplete: false,
  };
  tracked.requestId = tracked.assignmentId;
  tracked.instructionIds = [tracked.requestId!];
  deps.trackTask(tracked);
  let launched: HerdrLaunch;
  try {
    launched = await launchHerdrAgent(deps.pi, prompt, description, routeName, route, cwd, undefined, deps.manifestPath, params.capabilities, background, {
      assignmentId: tracked.assignmentId, readonly: params.readonly,
      onAllocated: (launch) => {
        Object.assign(tracked, { agentName: launch.agent, paneId: launch.paneId, tabId: launch.tabId, sessionId: launch.sessionId, sessionPath: launch.sessionPath });
        deps.trackTask(tracked);
      },
      onStarted: (launch) => {
        Object.assign(tracked, { agentName: launch.agent, paneId: launch.paneId, tabId: launch.tabId,
          terminalId: launch.terminalId, sessionId: launch.sessionId, sessionPath: launch.sessionPath });
        deps.trackTask(tracked);
      },
    });
    tracked.state = "running";
    deps.trackTask(tracked);
    deps.watchHerdrTask(tracked);
  } catch (error) {
    if (tracked.paneId && !(error instanceof OrchestrationError && error.detail.rollbackOccurred)) {
      tracked.state = "unknown"; tracked.presence = "unknown";
      tracked.error = error instanceof Error ? error.message : String(error);
      deps.trackTask(tracked); deps.watchHerdrTask(tracked);
      throw orchestrationError(error, "subagent", { ids: { handle, assignmentId: tracked.assignmentId }, retrySafe: "unknown", nextAction: `Launch outcome is unresolved for ${handle}. Inspect this exact handle before repeating the assignment.` });
    }
    tracked.state = "failed"; tracked.error = error instanceof Error ? error.message : String(error); deps.trackTask(tracked);
    throw error;
  }
  const policyNote = params.route === undefined ? ` Policy selected ${routeName}: ${decision.rationale}` : "";
  const fallbackNote = routePlan.fallbackFrom ? ` Policy fallback: ${routePlan.fallbackFrom} was unavailable, so ${routeName} was selected.` : "";
  return {
    text: `Launched Herdr ${phase} task ${handle}: agent ${launched.agent}, pane ${launched.paneId}, using ${route.provider}/${route.model} (${route.thinking}). ${params.route !== undefined ? "The explicit model is fixed." : "Fixed starting route with bounded provider failover on exhausted usage."} ${background ? "Background subagent: it never reports back; pull its latest output with subagent_control action=result." : "Do not poll; completion will wake the primary."}${policyNote}${fallbackNote}`,
    details: { handle, assignmentId: tracked.assignmentId, readonly: tracked.readonly, files: evidence.files, phase, background, dependsOn, ownedPaths, capabilities: params.capabilities, ...launched, fallbackFrom: routePlan.fallbackFrom, model: `${route.provider}/${route.model}`, thinking: route.thinking, decision, owner: params.owner },
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

/** A continuation is a new assignment/handle, never a second writer on an existing one. */
export async function continueRoutedTask(deps: LaunchDependencies, ctx: ExtensionContext, previous: TaskHandle, message: string, files?: string[]): Promise<RoutedTaskLaunchResult> {
  if (!message?.trim() || message.length > MAX_TASK_LENGTH) throw new Error("Continuation requires a bounded explicit follow-up instruction");
  const evidence = prepareEvidence(files, ctx.cwd, pathForResultRef);
  const initial = await validateContinuation(deps.pi, ctx, previous, deps.taskHandles.values());
  return withSessionStartLock(initial.path, async () => {
    const saved = await validateContinuation(deps.pi, ctx, previous, deps.taskHandles.values());
    const active = [...deps.taskHandles.values()].filter((task) => !task.background && isActiveTask(task)).length;
    if (active >= 4) throw new Error("Herdr subagent concurrency limit reached (4 active tasks)");
    validateWorkflowLaunch({ cwd: saved.cwd, dependsOn: [], ownedPaths: previous.ownedPaths ?? [], tasks: deps.taskHandles.values() });
    const assignmentId = randomUUID();
    const tracked: TaskHandle = {
      handle: newHandle(), assignmentId, requestId: assignmentId, parentSessionId: ctx.sessionManager.getSessionId(), workerManifestPath: deps.manifestPath, continuedFrom: previous.handle,
      minimumGeneration: 1, instructionIds: [assignmentId], route: `${saved.model.provider}/${saved.model.modelId}`, routeExplicit: previous.routeExplicit,
      target: "herdr", model: `${saved.model.provider}/${saved.model.modelId}`, thinking: saved.thinking, label: previous.label,
      cwd: saved.cwd, phase: previous.phase, ownedPaths: previous.ownedPaths, readonly: previous.readonly, capabilities: previous.capabilities,
      state: "queued", startedAt: Date.now(), sessionId: saved.id, sessionPath: saved.path, messageToken: randomUUID(), paneRetention: "close",
      transitions: 0, notifiedStates: [], usageStartOffset: saved.bytes, usageOffset: saved.bytes, estimatedCost: 0, costKnown: true, costComplete: true,
    };
    deps.trackTask(tracked);
    const route: Route = { label: previous.label, provider: saved.model.provider, model: saved.model.modelId, thinking: saved.thinking, purpose: "Saved-session continuation" };
    try {
      const launched = await launchHerdrAgent(deps.pi, [message.trim(), evidence.text].filter(Boolean).join("\n\n"), previous.label, tracked.route, route, saved.cwd,
        undefined, deps.manifestPath, previous.capabilities, false, { assignmentId, readonly: previous.readonly, continuation: { path: saved.path, id: saved.id },
          onAllocated: (launch) => { Object.assign(tracked, { agentName: launch.agent, paneId: launch.paneId, tabId: launch.tabId }); deps.trackTask(tracked); },
          onStarted: (launch) => { Object.assign(tracked, { terminalId: launch.terminalId }); deps.trackTask(tracked); },
        });
      tracked.state = "running"; deps.trackTask(tracked); deps.watchHerdrTask(tracked);
      return { text: `Continued ${previous.handle} as ${tracked.handle} in a fresh pane ${launched.paneId}, using its saved Pi session/model/working directory. Only the explicit follow-up was submitted; the original task was not replayed.`,
        details: { handle: tracked.handle, continuedFrom: previous.handle, assignmentId, ...launched, model: tracked.model, thinking: tracked.thinking, files: evidence.files }, task: tracked };
    } catch (error) {
      const ambiguous = tracked.paneId && !(error instanceof OrchestrationError && error.detail.rollbackOccurred);
      tracked.state = ambiguous ? "unknown" : "failed";
      tracked.presence = ambiguous ? "unknown" : undefined;
      tracked.error = error instanceof Error ? error.message : String(error);
      deps.trackTask(tracked); if (ambiguous) deps.watchHerdrTask(tracked);
      throw orchestrationError(error, "resume", { ids: { handle: tracked.handle, sessionId: saved.id, assignmentId }, nextAction: `Inspect ${tracked.handle} before another continuation; no original task or tool was replayed.` });
    }
  });
}
