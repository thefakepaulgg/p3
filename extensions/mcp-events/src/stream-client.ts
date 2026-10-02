import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport, ProtocolError,
  type JSONRPCNotification, type JSONRPCResponse, type MessageExtraInfo } from "@modelcontextprotocol/client";
import type { Cursor, StreamNotice } from "./types.ts";
import { BASE_REVISION, SUBSCRIPTION_ID, ContractError, discoverySchema, catalogSchema, parseNotice, schemaValidator, type EventDefinition } from "./protocol.ts";

export interface StreamParams { name: string; arguments: Record<string, unknown>; cursor: Cursor; }
export interface StreamOutcome { reason: "cancelled" | "disconnected" | "opening-timeout" | "heartbeat-timeout" | "terminated" | "contract-error" | "graceful"; error?: Error; }
export interface StreamHandle {
  id: string;
  opened: Promise<void>;
  closed: Promise<StreamOutcome>;
  close(): void;
}
export interface StreamOptions { openingMs?: number; heartbeatMs?: number; onNotice(notice: StreamNotice): void; }
interface OwnedStream { notice(raw: JSONRPCNotification): void; settle(outcome: StreamOutcome): void; }

export function localEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("Reference slice admits only http://127.0.0.1:PORT/mcp without credentials or redirects");
  }
  return url;
}

// The SDK parser otherwise buffers an arbitrarily long SSE frame before our schema validation.
async function boundedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  localEndpoint(String(input));
  const response = await fetch(input, { ...init, redirect: "error" });
  if (!response.body) return response;
  const sse = response.headers.get("content-type")?.split(";")[0] === "text/event-stream";
  let bytes = 0;
  let last = "";
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        bytes++;
        last = (last + String.fromCharCode(byte)).slice(-4);
        if (bytes > 64 * 1024) throw new ContractError("MCP frame exceeds 64 KiB");
        if (sse && (last.endsWith("\n\n") || last.endsWith("\r\n\r\n"))) bytes = 0;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** SDK 2.0.0 owned string IDs, public transport and protected dispatch hooks; no private timer access. */
export class EventsClient extends Client {
  private streams = new Map<string, OwnedStream>();
  private namespace = `events:${randomUUID()}:`;
  private nextId = 0;
  private definitions = new Map<string, EventDefinition>();
  eventsCapability: { listChanged?: boolean } = {};

  private constructor() {
    super({ name: "pi-mcp-events-reference", version: "0.0.1" }, {
      versionNegotiation: { mode: { pin: BASE_REVISION }, probe: { timeoutMs: 1000, maxRetries: 0 } },
    });
    for (const hook of ["_onnotification", "_onresponse", "_onclose", "_outboundMetaEnvelope"] as const) {
      if (typeof Client.prototype[hook] !== "function") throw new Error("Unsupported SDK hook contract");
    }
  }
  static async connectLocal(endpoint: string) {
    const client = new EventsClient();
    const transport = new StreamableHTTPClientTransport(localEndpoint(endpoint), {
      fetch: boundedFetch,
      // Only application cursors may reconnect: no automatic transport GET replay.
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    client.onerror = () => {}; // Errors settle owned streams or bounded requests; no raw sensitive-body logging.
    try {
      await client.connect(transport, { timeout: 1000 });
      // Normal SDK discovery strips unknown capabilities.events; explicitly preserve the draft capability.
      const discovery = await client.request({ method: "server/discover" }, discoverySchema, { timeout: 1000 });
      client.eventsCapability = discovery.capabilities.events;
      return client;
    } catch (error) { await client.close(); throw error; }
  }
  async listEvents() {
    const result: EventDefinition[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 16; page++) {
      const catalog = await this.request({ method: "events/list", params: cursor === undefined ? {} : { cursor } }, catalogSchema, { timeout: 1000 });
      for (const definition of catalog.events) {
        if (result.some(e => e.name === definition.name)) throw new ContractError("Duplicate event name in catalog");
        result.push(definition);
      }
      if (!catalog.nextCursor) {
        this.definitions = new Map(result.map(e => [e.name, e]));
        return result;
      }
      if (cursors.has(catalog.nextCursor)) throw new ContractError("Catalog pagination loop");
      cursors.add(catalog.nextCursor); cursor = catalog.nextCursor;
    }
    throw new ContractError("Catalog exceeds 16 pages");
  }
  openStream(params: StreamParams, options: StreamOptions): StreamHandle {
    if (!this.transport) throw new Error("Client is not connected");
    const definition = this.definitions.get(params.name);
    if (!definition?.delivery.includes("push")) throw new ContractError("Event does not advertise push; no fallback enabled");
    if (!schemaValidator(definition.inputSchema)(params.arguments)) throw new ContractError("Subscription arguments do not match inputSchema");
    const payloadValid = schemaValidator(definition.payloadSchema);
    const id = `${this.namespace}${++this.nextId}`;
    const abort = new AbortController();
    let state: "opening" | "active" | "closed" = "opening";
    let openingTimer: NodeJS.Timeout;
    let watchdog: NodeJS.Timeout | undefined;
    let resolveOpening!: () => void;
    let rejectOpening!: (error: Error) => void;
    let resolveClosed!: (outcome: StreamOutcome) => void;
    const opened = new Promise<void>((resolve, reject) => { resolveOpening = resolve; rejectOpening = reject; });
    void opened.catch(() => {});
    const closed = new Promise<StreamOutcome>(resolve => { resolveClosed = resolve; });
    const settle = (outcome: StreamOutcome) => {
      if (state === "closed") return;
      const wasOpening = state === "opening";
      if (wasOpening && outcome.reason === "graceful") outcome = { reason: "contract-error", error: new ContractError("Final result before active acknowledgment") };
      state = "closed";
      clearTimeout(openingTimer); clearTimeout(watchdog);
      this.streams.delete(id);
      abort.abort();
      if (wasOpening) rejectOpening(outcome.error ?? new Error(`Stream closed before active: ${outcome.reason}`));
      resolveClosed(outcome);
    };
    const refreshWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settle({ reason: "heartbeat-timeout", error: new Error("Events heartbeat watchdog expired") }), (options.heartbeatMs ?? 30_000) * 2);
    };
    this.streams.set(id, { settle, notice: raw => {
      try {
        if (Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024) throw new ContractError("Event frame too large");
        const notice = parseNotice(raw.method, raw.params);
        if (notice.kind === "active") {
          if (state === "opening") { clearTimeout(openingTimer); state = "active"; resolveOpening(); refreshWatchdog(); }
        } else if (notice.kind !== "terminated" && state !== "active") throw new ContractError("Event stream delivered before active");
        if (notice.kind === "event") {
          if (notice.event.name !== params.name || !payloadValid(notice.event.data)) throw new ContractError("Event violates admitted payload schema/name");
          refreshWatchdog();
        }
        if (notice.kind === "heartbeat") refreshWatchdog();
        options.onNotice(notice);
        if (notice.kind === "terminated") settle({ reason: "terminated", error: ProtocolError.fromError(notice.error.code, notice.error.message, notice.error.data) });
      } catch (error) { settle({ reason: "contract-error", error: error instanceof Error ? error : new Error("Invalid Events traffic") }); }
    } });
    openingTimer = setTimeout(() => settle({ reason: "opening-timeout", error: new Error("Events active acknowledgment deadline expired") }), options.openingMs ?? 5000);
    // Don't await send: headers can hang, while the owned opening timer aborts this exact request.
    void this.transport.send({ jsonrpc: "2.0", id, method: "events/stream", params: { ...params, _meta: { ...this._outboundMetaEnvelope() } } }, {
      requestSignal: abort.signal,
      onRequestStreamEnd: () => settle({ reason: "disconnected", error: new Error("Events POST/SSE ended") }),
    }).catch(error => settle({ reason: error instanceof ContractError ? "contract-error" : "disconnected", error }));
    return { id, opened, closed, close: () => settle({ reason: "cancelled" }) };
  }
  protected override _onnotification(raw: JSONRPCNotification, extra?: MessageExtraInfo) {
    const id = raw.params?._meta?.[SUBSCRIPTION_ID];
    if (typeof id === "string" && id.startsWith(this.namespace)) {
      this.streams.get(id)?.notice(raw); return; // Retired IDs are deliberately dropped, not delegated.
    }
    if (raw.method.startsWith("notifications/events/") && raw.method !== "notifications/events/list_changed") return;
    super._onnotification(raw, extra);
  }
  protected override _onresponse(response: JSONRPCResponse) {
    if (typeof response.id === "string" && response.id.startsWith(this.namespace)) {
      const owned = this.streams.get(response.id);
      if (!owned) return;
      if ("error" in response) owned.settle({ reason: "terminated", error: ProtocolError.fromError(response.error.code, response.error.message, response.error.data) });
      else if (response.result.resultType !== "complete") owned.settle({ reason: "contract-error", error: new ContractError("Modern final result missing complete resultType") });
      else owned.settle({ reason: "graceful" });
      return;
    }
    super._onresponse(response);
  }
  protected override _onclose() {
    for (const stream of [...this.streams.values()]) stream.settle({ reason: "disconnected", error: new Error("Client transport closed") });
    super._onclose();
  }
  override async close() {
    for (const stream of [...this.streams.values()]) stream.settle({ reason: "cancelled" });
    await super.close();
  }
}
