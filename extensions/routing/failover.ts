import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { estimateTokens, getAgentDir, VIRTUAL_MODEL_STATE_ENTRY, type ExtensionAPI, type ExtensionContext, type ModelRoute, type ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, fallbackChains, routes, type RouteName, type ThinkingLevel } from "./policy.ts";

const wrapperProvider = "p3-failover";
const anthropicApiProvider = "anthropic-api";
const allowedProviders = new Set(["anthropic", anthropicApiProvider, "openai-codex"]);
const cooldownCap = 60 * 60 * 1000;
type LimitReason = "quota" | "usage-limit" | "rate-limit" | "overload";
type PhysicalRoute = { provider: string; model: string; thinkingLevel: ThinkingLevel };

export interface FailoverState {
  assignmentId: string | null;
  selected: PhysicalRoute;
  preferred?: PhysicalRoute;
  triedProviders: string[];
  switchReason?: string;
}

interface Cooldown { provider: string; reason: LimitReason; until: number }
interface Dispatch {
  selection: string;
  physical: PhysicalRoute;
  response?: { status: number; headers: Record<string, string> };
}
// Response hooks have no model identity. Only associate a response with our latest routed dispatch.
const dispatches = new Map<string, Dispatch>();

function cooldownPath(provider: string): string {
  return join(getAgentDir(), "state", "model-routing", `${provider}.json`);
}

export function providerIsCoolingDown(provider: string): boolean {
  if (!allowedProviders.has(provider)) return false;
  try {
    const value = JSON.parse(readFileSync(cooldownPath(provider), "utf8")) as Cooldown;
    return value.provider === provider && ["quota", "usage-limit", "rate-limit", "overload"].includes(value.reason)
      && Number.isFinite(value.until) && value.until > Date.now() && value.until <= Date.now() + cooldownCap;
  } catch {
    return false;
  }
}

function headerDelay(headers: Record<string, string>, now: number): number | undefined {
  const delays: number[] = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    let delay: number | undefined;
    if (name === "retry-after") {
      delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    } else if (["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset"].includes(name)) {
      delay = Date.parse(value) - now;
    } else if (["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"].includes(name)) {
      const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
      delay = duration && duration[0] ? (Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0)) * 1000 : Date.parse(value) - now;
    } else if (["x-codex-primary-reset-after-seconds", "x-codex-secondary-reset-after-seconds"].includes(name) && /^\d+$/.test(value)) {
      delay = Number(value) * 1000;
    }
    if (delay !== undefined && Number.isFinite(delay) && delay > 0) delays.push(delay);
  }
  return delays.length ? Math.min(cooldownCap, Math.max(...delays)) : undefined;
}

function coolProvider(provider: string, reason: LimitReason, headers?: Record<string, string>, resetDelay?: number): void {
  if (!allowedProviders.has(provider)) return;
  const now = Date.now();
  const delay = (headers && headerDelay(headers, now)) ?? resetDelay ?? (reason === "quota" ? 15 * 60 * 1000 : 60 * 1000);
  const until = now + Math.min(cooldownCap, delay);
  const path = cooldownPath(provider);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(getAgentDir(), "state", "model-routing"), { recursive: true, mode: 0o700 });
    // A later short transient failure must not shorten an existing quota cooldown.
    let existing: Cooldown | undefined;
    try { existing = JSON.parse(readFileSync(path, "utf8")) as Cooldown; } catch { /* No prior cooldown. */ }
    const value: Cooldown = existing?.provider === provider && Number.isFinite(existing.until)
      && existing.until > until && existing.until <= now + cooldownCap
      && ["quota", "usage-limit", "rate-limit", "overload"].includes(existing.reason) ? existing : { provider, reason, until };
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Shared cooldown storage is advisory; an unwritable state directory cannot prevent dispatch.
    try { unlinkSync(temporary); } catch { /* No temporary file. */ }
  }
}

function limitReason(message: AssistantMessage): LimitReason | undefined {
  if (message.stopReason !== "error" || !allowedProviders.has(message.provider)) return undefined;
  const text = message.errorMessage ?? "";
  if (/\b(?:abort(?:ed)?|cancel(?:led|ed)?|unauthorized|authentication|invalid_api_key|permission_denied|forbidden|invalid_request_error|request_too_large|bad request)\b|invalid (?:api |access )?token|token.{0,12}expired|context.{0,24}(?:length|window|limit|overflow)|too many tokens|(?:prompt|input).{0,20}(?:too long|token limit)|(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:400|401|403)\b|^(?:400|401|403)\s*[:{]/i.test(text)) return undefined;
  if (message.provider === "openai-codex" && /usage_limit_reached|usage_not_included|subscription_sharing_usage_limit_exceeded|monthly usage limit reached|(?:quota|usage limit) (?:exceeded|reached)|insufficient_quota|out of budget/i.test(text)) return "quota";
  // Codex also uses this phrase for transient 429s; it does not prove quota exhaustion.
  if (message.provider === "openai-codex" && /you have hit your ChatGPT usage limit/i.test(text)) return "usage-limit";
  if ((message.provider === "anthropic" || message.provider === anthropicApiProvider) && /(?:usage|spend|credit) (?:limit|balance).{0,40}(?:reached|exceeded|exhausted|too low)|(?:exceed(?:ed)?|reached).{0,60}(?:usage|spend) limits?|credit balance is too low|insufficient[_ ](?:credits|quota)|usage_limit_reached/i.test(text)) return "quota";
  if (/rate_limit(?:_error|_exceeded)?|rate[ -]limit(?:ed|ing)?|too many requests|(?:HTTP|status(?: code)?)\s*[:=]?\s*429\b|^429\s*[:{]/i.test(text)) return "rate-limit";
  if (/overloaded_error|\boverloaded\b|(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:503|529)\b/i.test(text)) return "overload";
  return undefined;
}

export function wrappedModelRef(name: RouteName): string {
  return `${wrapperProvider}/${name}`;
}

function selectionRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function automatic(model: ExtensionContext["model"]): boolean {
  return !!model && model.api === "pi-virtual" && (model.provider === wrapperProvider && model.id in routes
    || model.provider === "openai-codex" && model.id === "auto");
}

function assignmentId(ctx: ExtensionContext): string | null {
  for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
    if (entry.type === "message" && entry.message.role === "user") return entry.id;
  }
  return null;
}

function routeName(physical: PhysicalRoute): RouteName | undefined {
  return (Object.keys(routes) as RouteName[]).find(name => routes[name].model === physical.model
    && (routes[name].provider === physical.provider
      || (routes[name].provider === "anthropic" && physical.provider === anthropicApiProvider)));
}

function physical(route: ModelRoute): PhysicalRoute {
  return { provider: route.model.provider, model: route.model.id, thinkingLevel: clampThinkingLevel(route.thinkingLevel) };
}

async function eligible(model: Model<Api>, messages: readonly Message[], ctx: ExtensionContext): Promise<boolean> {
  if (model.api === "pi-virtual") return false;
  if (!model.input.includes("image") && messages.some(message => Array.isArray(message.content)
    && message.content.some((block: unknown) => typeof block === "object" && block !== null && "type" in block && block.type === "image"))) return false;
  const tokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (model.contextWindow <= 0 || tokens + model.maxTokens >= model.contextWindow) return false;
  if (model.provider === "anthropic" && !ctx.modelRegistry.isUsingOAuth(model)) return false;
  return ctx.modelRegistry.hasConfiguredAuth(model) && (await ctx.modelRegistry.getApiKeyAndHeaders(model)).ok;
}

async function replacement(selected: PhysicalRoute, tried: readonly string[], messages: readonly Message[], ctx: ExtensionContext): Promise<ModelRoute | undefined> {
  const name = routeName(selected);
  if (!name) return undefined;
  for (const candidate of fallbackChains[name]) {
    const spec = routes[candidate];
    const providers = spec.provider === "anthropic" ? ["anthropic", anthropicApiProvider] : [spec.provider];
    for (const provider of providers) {
      if (!allowedProviders.has(provider) || tried.includes(provider) || providerIsCoolingDown(provider)) continue;
      const model = ctx.modelRegistry.find(provider, spec.model);
      if (model && await eligible(model, messages, ctx)) {
        return { model, thinkingLevel: clampThinkingLevel(selected.thinkingLevel) };
      }
    }
  }
  return undefined;
}

function switched(state: FailoverState, route: ModelRoute, reason: string, ctx: ExtensionContext): FailoverState {
  const target = physical(route);
  ctx.ui.notify(`Automatic provider failover: ${state.selected.provider}/${state.selected.model} (${reason}) → ${target.provider}/${target.model}.`, "warning");
  return { ...state, selected: target, triedProviders: [...new Set([...state.triedProviders, target.provider])], switchReason: reason };
}

function observeFailure(message: AssistantMessage, ctx: ExtensionContext): LimitReason | undefined {
  const reason = limitReason(message);
  if (!reason) return undefined;
  const dispatch = dispatches.get(ctx.sessionManager.getSessionId());
  const response = dispatch?.physical.provider === message.provider && dispatch.physical.model === message.model ? dispatch.response : undefined;
  const reset = message.provider === "openai-codex" && /you have hit your ChatGPT usage limit/i.test(message.errorMessage ?? "")
    ? /Try again in ~(\d+) min\./i.exec(message.errorMessage ?? "") : null;
  const resetDelay = reset && Number(reset[1]) > 0 ? Math.min(cooldownCap, Number(reset[1]) * 60 * 1000) : undefined;
  coolProvider(message.provider, reason, response && response.status >= 400 ? response.headers : undefined, resetDelay);
  return reason;
}

export async function routeWithFailover(
  request: ModelRouteRequest<FailoverState>, ctx: ExtensionContext,
  chooseInitial: () => Promise<ModelRoute> | ModelRoute,
): Promise<ModelRoute<FailoverState>> {
  const session = ctx.sessionManager.getSessionId();
  request.signal?.throwIfAborted();
  const failedReason = request.reason === "retry" && request.failed ? observeFailure(request.failed.message, ctx) : undefined;
  dispatches.delete(session);
  // Direct calls (e.g. compaction) must not consume the agent assignment's failover allowance.
  if (request.reason === "direct") {
    const route = await chooseInitial();
    return { model: route.model, thinkingLevel: clampThinkingLevel(route.thinkingLevel) };
  }
  const id = assignmentId(ctx);
  let state = request.state;
  // Pi can report `user` again after an error. The persisted user entry, not that hint, owns the reset.
  if (!state || state.assignmentId !== id) {
    // New assignments need a fresh capability judgment; a previous small fallback may be inadequate.
    const initial = await chooseInitial();
    state = { assignmentId: id, selected: physical(initial), preferred: physical(initial), triedProviders: [initial.model.provider] };
    if (providerIsCoolingDown(initial.model.provider) || !await eligible(initial.model, request.messages, ctx)) {
      const fallback = await replacement(state.selected, [], request.messages, ctx);
      if (!fallback) throw new Error(`No eligible automatic route for ${initial.model.provider}/${initial.model.id}.`);
      state = switched(state, fallback, providerIsCoolingDown(initial.model.provider) ? "provider cooling down" : "physical model unavailable or incompatible", ctx);
    }
  } else if (request.reason === "retry" && request.failed) {
    // Rate limits, ambiguous Codex usage errors and overloads retain the core retry budget.
    if (failedReason === "quota" && request.failed.model.provider === state.selected.provider
      && request.failed.model.id === state.selected.model) {
      const fallback = await replacement(state.selected, state.triedProviders, request.messages, ctx);
      if (fallback) state = switched(state, fallback, failedReason, ctx);
    }
  }
  request.signal?.throwIfAborted();
  const model = ctx.modelRegistry.find(state.selected.provider, state.selected.model);
  if (!model || model.api === "pi-virtual") throw new Error(`Physical route unavailable: ${state.selected.provider}/${state.selected.model}.`);
  const thinkingLevel = clampThinkingLevel(state.selected.thinkingLevel);
  dispatches.set(session, { selection: selectionRef(request.model), physical: state.selected });
  return { model, thinkingLevel, state };
}

export function registerFailoverModels(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const models = ctx.modelRegistry.getAll().filter(model => model.provider === "anthropic");
    pi.registerProvider(anthropicApiProvider, {
      name: "Anthropic API key",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      apiKey: "$ANTHROPIC_API_KEY",
      models: models.map(({ provider, ...model }) => model),
    });
  });
  for (const name of Object.keys(routes) as RouteName[]) {
    pi.registerVirtualModel<FailoverState>({
      provider: wrapperProvider, id: name, name: `${routes[name].label} (automatic failover)`,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      route: (request, ctx) => routeWithFailover(request, ctx, () => {
        const spec = routes[name];
        const configured = ctx.modelRegistry.find(spec.provider, spec.model);
        const model = configured && ctx.modelRegistry.hasConfiguredAuth(configured) ? configured
          : spec.provider === "openai-codex" ? ctx.modelRegistry.find("openai", spec.model) : configured;
        if (!model) throw new Error(`Physical route unavailable: ${spec.provider}/${spec.model}.`);
        return { model, thinkingLevel: clampThinkingLevel(request.thinkingLevel) };
      }),
    });
  }
  pi.on("after_provider_response", (event, ctx) => {
    const dispatch = dispatches.get(ctx.sessionManager.getSessionId());
    if (!automatic(ctx.model) || !dispatch || dispatch.selection !== selectionRef(ctx.model!)) return;
    dispatch.response = { status: event.status, headers: event.status >= 400 ? event.headers : {} };
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "error" || event.continue || ctx.signal?.aborted || !automatic(ctx.model)) return;
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.slice().reverse().find(item => item.type === "custom" && item.customType === VIRTUAL_MODEL_STATE_ENTRY
      && (item.data as { provider?: string; modelId?: string } | undefined)?.provider === ctx.model!.provider
      && (item.data as { modelId?: string } | undefined)?.modelId === ctx.model!.id);
    if (entry?.type !== "custom") return;
    const state = (entry.data as { state: FailoverState }).state;
    if (!state?.selected || state.assignmentId !== assignmentId(ctx)) return;
    const projected = event.context.contextEntries.slice().reverse().find(item => item.messages.some(message => message.role === "assistant"));
    const failure = projected?.messages.slice().reverse().find(message => message.role === "assistant");
    if (!projected || failure?.role !== "assistant" || failure.provider !== state.selected.provider || failure.model !== state.selected.model) return;
    const reason = observeFailure(failure, ctx);
    if (!reason) return;
    // Only omit the failed assistant, never its user request or any completed tool results.
    if (projected.sourceEntry.type !== "message" || projected.messages.length !== 1) return;
    const remaining = event.context.contextEntries.filter(item => item.sourceEntry.id !== projected.sourceEntry.id).flatMap(item => item.messages);
    const canContinue = event.context.canContinue || remaining.some(message => message.role !== "system") && remaining.at(-1)?.role !== "assistant";
    if (!canContinue) return;
    const messages = event.context.llmMessages.filter(message => !(message.role === "assistant" && message.timestamp === failure.timestamp
      && message.provider === failure.provider && message.model === failure.model));
    const fallback = await replacement(state.selected, state.triedProviders, messages, ctx);
    if (!fallback || ctx.signal?.aborted) return;
    const next = switched(state, fallback, reason, ctx);
    // Core recomputes canContinue after these drafts; the failed attempt remains in raw history.
    return {
      continue: true,
      entries: [
        { type: "context_edit", targetId: projected.sourceEntry.id, replacement: null },
        { type: "custom", customType: VIRTUAL_MODEL_STATE_ENTRY, data: { provider: ctx.model!.provider, modelId: ctx.model!.id, state: next } },
      ],
    };
  });
}
