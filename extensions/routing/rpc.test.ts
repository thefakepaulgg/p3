import { expect, test } from "bun:test";
import { registerRoutingRpc, ROUTING_RPC_CHANNELS, type EventBus } from "./rpc.ts";
import { ROUTING_RPC_VERSION } from "./state.ts";

const bus = () => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events: EventBus = {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    },
    emit(name, data) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(data);
    },
  };
  return events;
};

const request = async (events: EventBus, channel: string, payload: Record<string, unknown>) => {
  const requestId = String(payload.requestId ?? crypto.randomUUID());
  const replyChannel = `${channel}:reply:${requestId}`;
  const reply = new Promise<any>((resolve) => events.on(replyChannel, resolve));
  events.emit(channel, { ...payload, requestId });
  return reply;
};

test("versioned routing RPC preserves launch/status/result/stop parity and owner correlation", async () => {
  const events = bus();
  const calls: Array<[string, unknown]> = [];
  const registration = registerRoutingRpc(events, {
    launch: async (params, owner) => {
      calls.push(["launch", { params, owner }]);
      return { text: "launched", details: { handle: "rt-1" }, task: undefined };
    },
    status: async (handle) => { calls.push(["status", handle]); return { handle, state: "running", result: undefined }; },
    result: async (handle) => { calls.push(["result", handle]); return { handle, result: "full routed result", available: true }; },
    stop: async (handle, closePane) => { calls.push(["stop", { handle, closePane }]); return { handle, state: "stopped" }; },
  });

  expect((await request(events, ROUTING_RPC_CHANNELS.ping, {})).data).toEqual({ version: ROUTING_RPC_VERSION });
  const launched = await request(events, ROUTING_RPC_CHANNELS.launch, {
    version: ROUTING_RPC_VERSION,
    task: "Implement the bounded workflow step",
    description: "Workflow step",
    capabilities: ["memory"],
    owner: { kind: "workflow", runId: "r".repeat(200), stepId: "step-1", attemptId: "attempt-1" },
  });
  expect(launched.success).toBe(true);
  const launchCall = calls.find(([kind]) => kind === "launch")![1] as any;
  expect(launchCall.owner).toEqual({ kind: "workflow", runId: "r".repeat(128), stepId: "step-1", attemptId: "attempt-1" });
  expect(launchCall.params.capabilities).toEqual(["memory"]);

  expect((await request(events, ROUTING_RPC_CHANNELS.status, { handle: "rt-1" })).data).toEqual({ handle: "rt-1", state: "running", result: undefined });
  expect((await request(events, ROUTING_RPC_CHANNELS.result, { handle: "rt-1" })).data.result).toBe("full routed result");
  expect((await request(events, ROUTING_RPC_CHANNELS.stop, { handle: "rt-1", close_pane: true })).data).toEqual({ handle: "rt-1", state: "stopped" });
  expect(calls.map(([kind]) => kind)).toEqual(["launch", "status", "result", "stop"]);
  registration.unsubscribe();
});

test("routing RPC validates launch parameters before invoking the handler", async () => {
  const events = bus(); let launches = 0;
  const registration = registerRoutingRpc(events, {
    launch: async () => { launches += 1; return { text: "", details: {} }; },
    status: async () => ({}), result: async () => ({ handle: "", result: "", available: false }), stop: async () => ({}),
  });
  const invalidSurface = await request(events, ROUTING_RPC_CHANNELS.launch, { task: "x", description: "step", surface: "bogus" });
  const invalidIsolation = await request(events, ROUTING_RPC_CHANNELS.launch, { task: "x", description: "step", isolation: "worktree" });
  const invalidCapability = await request(events, ROUTING_RPC_CHANNELS.launch, { task: "x", description: "step", capabilities: ["shell"] });
  expect(invalidSurface.success).toBe(false);
  expect(invalidIsolation.success).toBe(false);
  expect(invalidCapability).toEqual({ success: false, error: "capabilities must contain only memory" });
  expect(launches).toBe(0);
  registration.unsubscribe();
});

test("routing RPC replies with bounded protocol failures", async () => {
  const events = bus();
  const registration = registerRoutingRpc(events, {
    launch: async () => { throw new Error("should not launch"); },
    status: async () => ({}), result: async () => ({ handle: "", result: "", available: false }), stop: async () => ({}),
  });
  const unsupported = await request(events, ROUTING_RPC_CHANNELS.ping, { version: 99 });
  expect(unsupported).toEqual({ success: false, error: "Unsupported routing RPC version: 99" });
  const missingHandle = await request(events, ROUTING_RPC_CHANNELS.status, {});
  expect(missingHandle).toEqual({ success: false, error: "handle is required" });
  registration.unsubscribe();
});
