import { orchestrationError, type OrchestrationErrorDetails } from "./errors.ts";
import { ROUTING_RPC_VERSION, normalizeTaskOwner, type TaskOwner } from "./state.ts";
import { validateRoutedTaskLaunchParams, type RoutedTaskLaunchParams, type RoutedTaskLaunchResult } from "./launch.ts";

export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export const ROUTING_RPC_CHANNELS = {
  ping: "routing:rpc:ping",
  launch: "routing:rpc:launch",
  status: "routing:rpc:status",
  result: "routing:rpc:result",
  stop: "routing:rpc:stop",
  steer: "routing:rpc:steer",
  list: "routing:rpc:list",
} as const;

export interface RoutingRpcTaskStatus { [key: string]: unknown }
export interface RoutingRpcResult { handle: string; result: string; available: boolean }

export interface RoutingRpcHandlers {
  launch: (params: RoutedTaskLaunchParams, owner?: TaskOwner) => Promise<RoutedTaskLaunchResult>;
  status: (handle: string) => Promise<RoutingRpcTaskStatus>;
  result: (handle: string) => Promise<RoutingRpcResult>;
  stop: (handle: string, closePane?: boolean) => Promise<RoutingRpcTaskStatus>;
  steer: (handle: string, message: string) => Promise<RoutingRpcTaskStatus>;
  list: () => Promise<RoutingRpcTaskStatus[]>;
}

export interface RoutingRpcRegistration { unsubscribe: () => void }

type Request = { requestId: string; version?: number } & Record<string, unknown>;

type Reply = { success: true; data?: unknown } | { success: false; error: string; errorDetails?: OrchestrationErrorDetails };

const invalidRequest = (error: unknown, operation: string) => orchestrationError(error, operation, {
  category: "invalid_request", stage: "validation", retrySafe: true,
  nextAction: "Correct the request before retrying.",
});

const boundedRequestId = (requestId: unknown): string => {
  if (typeof requestId !== "string" || !requestId.trim()) throw new Error("requestId is required");
  const normalized = requestId.trim();
  if (normalized.length > 160) throw new Error("requestId exceeds the 160 character limit");
  return normalized;
};

const assertVersion = (version: unknown): void => {
  if (version !== undefined && version !== ROUTING_RPC_VERSION) throw new Error(`Unsupported routing RPC version: ${String(version)}`);
};

const reply = async (events: EventBus, channel: string, raw: unknown, fn: (request: Request) => Promise<unknown> | unknown) => {
  const request = (raw ?? {}) as Request;
  let requestId: string;
  try { requestId = boundedRequestId(request.requestId); }
  catch { return; }
  try {
    try { assertVersion(request.version); }
    catch (error) { throw invalidRequest(error, channel); }
    const data = await fn(request);
    const envelope: Reply = data === undefined ? { success: true } : { success: true, data };
    events.emit(`${channel}:reply:${requestId}`, envelope);
  } catch (error) {
    const failure = orchestrationError(error, channel);
    const envelope: Reply = { success: false, error: failure.message, errorDetails: failure.detail };
    events.emit(`${channel}:reply:${requestId}`, envelope);
  }
};

/** Register versioned routing RPC handlers on Pi's extension event bus. */
export function registerRoutingRpc(events: EventBus, handlers: RoutingRpcHandlers): RoutingRpcRegistration {
  const unsubs = [
    events.on(ROUTING_RPC_CHANNELS.ping, (raw) => void reply(events, ROUTING_RPC_CHANNELS.ping, raw, () => ({ version: ROUTING_RPC_VERSION }))),
    events.on(ROUTING_RPC_CHANNELS.launch, (raw) => void reply(events, ROUTING_RPC_CHANNELS.launch, raw, async (request) => {
      const params = request as unknown as RoutedTaskLaunchParams;
      try { validateRoutedTaskLaunchParams(params); }
      catch (error) { throw invalidRequest(error, ROUTING_RPC_CHANNELS.launch); }
      const owner = normalizeTaskOwner(request.owner);
      return handlers.launch(params, owner);
    })),
    events.on(ROUTING_RPC_CHANNELS.status, (raw) => void reply(events, ROUTING_RPC_CHANNELS.status, raw, async (request) => {
      if (typeof request.handle !== "string" || !request.handle.trim()) throw invalidRequest(new Error("handle is required"), ROUTING_RPC_CHANNELS.status);
      return handlers.status(request.handle.trim());
    })),
    events.on(ROUTING_RPC_CHANNELS.result, (raw) => void reply(events, ROUTING_RPC_CHANNELS.result, raw, async (request) => {
      if (typeof request.handle !== "string" || !request.handle.trim()) throw invalidRequest(new Error("handle is required"), ROUTING_RPC_CHANNELS.result);
      return handlers.result(request.handle.trim());
    })),
    events.on(ROUTING_RPC_CHANNELS.stop, (raw) => void reply(events, ROUTING_RPC_CHANNELS.stop, raw, async (request) => {
      if (typeof request.handle !== "string" || !request.handle.trim()) throw invalidRequest(new Error("handle is required"), ROUTING_RPC_CHANNELS.stop);
      return handlers.stop(request.handle.trim(), request.close_pane === true);
    })),
    events.on(ROUTING_RPC_CHANNELS.list, (raw) => void reply(events, ROUTING_RPC_CHANNELS.list, raw, () => handlers.list())),
    events.on(ROUTING_RPC_CHANNELS.steer, (raw) => void reply(events, ROUTING_RPC_CHANNELS.steer, raw, async (request) => {
      if (typeof request.handle !== "string" || !request.handle.trim()) throw invalidRequest(new Error("handle is required"), ROUTING_RPC_CHANNELS.steer);
      if (typeof request.message !== "string" || !request.message.trim()) throw invalidRequest(new Error("message is required"), ROUTING_RPC_CHANNELS.steer);
      return handlers.steer(request.handle.trim(), request.message.trim());
    })),
  ];
  return { unsubscribe: () => unsubs.splice(0).forEach((unsubscribe) => unsubscribe()) };
}
