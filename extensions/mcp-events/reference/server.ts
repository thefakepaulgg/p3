import { createServer, type Server, type ServerResponse } from "node:http";
import type { EventOccurrence } from "../src/types.ts";

const VERSION = "2026-07-28";
const SUB_ID = "io.modelcontextprotocol/subscriptionId";
const definitions = [
  {
    name: "job.completed", description: "Synthetic completion, not a real job",
    delivery: ["push"],
    inputSchema: { type: "object", properties: { jobId: { type: "string", minLength: 1 } }, required: ["jobId"], additionalProperties: false },
    payloadSchema: { type: "object", properties: { jobId: { type: "string" }, state: { type: "string", enum: ["complete"] } }, required: ["jobId", "state"], additionalProperties: false },
  },
  { name: "webhook.only", description: "Unsupported mode fixture", delivery: ["webhook"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } },
];

interface OpenRequest {
  id: string;
  params: { name: string; arguments: { jobId: string }; cursor: string | null; _meta: Record<string, unknown> };
}
interface LiveStream { request: OpenRequest; response: ServerResponse; timer?: NodeJS.Timeout; ready: boolean; }
export interface ReferenceOptions { heartbeatMs?: number; omitActive?: boolean; openingDelayMs?: number; historyLimit?: number; rejectCode?: number; streamResponse?: "json" | "accepted"; replayable?: boolean; }

/** Loopback-only, ephemeral fixture. Fault controls are local methods, never network endpoints. */
export class ReferenceServer {
  private server: Server;
  private streams = new Map<string, LiveStream>();
  private history: EventOccurrence[] = [];
  private position = 0;
  private options: ReferenceOptions;
  url = "";
  opens: OpenRequest[] = [];
  requests: string[] = [];
  cancellations = 0;
  gets = 0;
  maxConcurrent = 0;

  private constructor(options: ReferenceOptions) {
    this.options = options;
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => res.destroy()); });
  }
  static async start(options: ReferenceOptions = {}) {
    const fixture = new ReferenceServer(options);
    await new Promise<void>(resolve => fixture.server.listen(0, "127.0.0.1", resolve));
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("No reference address");
    fixture.url = `http://127.0.0.1:${address.port}/mcp`;
    return fixture;
  }
  get activeCount() { return this.streams.size; }
  private cursor() { return this.options.replayable === false ? null : `ref-${this.position}`; }
  private json(res: ServerResponse, id: unknown, result: Record<string, unknown>) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } }));
  }
  private error(res: ServerResponse, id: unknown, code: number, message: string) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
  private async handle(req: import("node:http").IncomingMessage, res: ServerResponse) {
    if (req.method === "GET") { this.gets++; res.writeHead(405).end(); return; }
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    this.requests.push(rpc.method);
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    if (rpc.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== VERSION) {
      this.error(res, rpc.id, -32602, "Expected explicit modern request envelope"); return;
    }
    if (rpc.method === "server/discover") {
      this.json(res, rpc.id, { supportedVersions: [VERSION], capabilities: { events: { listChanged: true } }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "synthetic-events-reference", version: "0.0.1" } } }); return;
    }
    if (rpc.method === "events/list") {
      const second = rpc.params?.cursor === "catalog-2";
      this.json(res, rpc.id, { events: [definitions[second ? 1 : 0]], ...(!second && { nextCursor: "catalog-2" }) }); return;
    }
    if (rpc.method === "test/hang") { return; }
    if (rpc.method !== "events/stream") { this.error(res, rpc.id, -32601, "Method not found"); return; }
    if (this.options.rejectCode) { this.error(res, rpc.id, this.options.rejectCode, "Synthetic rejection"); return; }
    const args = rpc.params.arguments;
    if (rpc.params.name !== "job.completed" || !args || typeof args.jobId !== "string" || !args.jobId || Object.keys(args).some(k => k !== "jobId")) {
      this.error(res, rpc.id, -32602, "Invalid synthetic subscription"); return;
    }
    if (this.options.streamResponse === "json") { this.json(res, rpc.id, { _meta: {} }); return; }
    if (this.options.streamResponse === "accepted") { res.writeHead(202).end(); return; }
    this.opens.push(structuredClone(rpc));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    const live: LiveStream = { request: rpc, response: res, ready: false };
    this.streams.set(rpc.id, live);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.activeCount);
    res.on("close", () => {
      if (this.streams.delete(rpc.id)) this.cancellations++;
      clearInterval(live.timer);
    });
    const activate = () => {
      if (!this.streams.has(rpc.id) || this.options.omitActive) return;
      const input = rpc.params.cursor;
      const parsed = typeof input === "string" && /^ref-\d+$/.test(input) ? Number(input.slice(4)) : this.position;
      const oldest = this.history[0]?.cursor;
      const floor = typeof oldest === "string" ? Number(oldest.slice(4)) - 1 : this.position;
      const truncated = input !== null && (parsed < floor || parsed > this.position || !/^ref-\d+$/.test(input));
      const from = this.options.replayable === false || input === null || truncated ? this.position : parsed;
      this.write(live, "active", { cursor: this.options.replayable === false ? null : `ref-${from}`, truncated });
      for (const event of this.history) if (Number(event.cursor?.slice(4)) > from && event.data.jobId === args.jobId) this.write(live, "event", event);
      live.ready = true;
      const interval = this.options.heartbeatMs ?? 100;
      if (interval > 0) live.timer = setInterval(() => this.write(live, "heartbeat", { cursor: this.cursor() }), interval);
    };
    if (this.options.openingDelayMs) { live.timer = setTimeout(activate, this.options.openingDelayMs); }
    else activate();
  }
  private write(live: LiveStream, kind: string, params: Record<string, unknown> | EventOccurrence) {
    // A distinct transport id intentionally exercises SDK resumption suppression.
    live.response.write(`id: wire-${this.position}\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/events/${kind}`, params: { ...params, _meta: { [SUB_ID]: live.request.id } } })}\n\n`);
  }
  emit(jobId: string, eventId = `evt-${this.position + 1}`): EventOccurrence {
    this.position++;
    const event: EventOccurrence = { eventId, name: "job.completed", timestamp: "2026-10-02T12:00:00.000Z", data: { jobId, state: "complete" }, cursor: this.cursor() };
    this.history.push(event);
    this.history = this.history.slice(-(this.options.historyLimit ?? 64));
    this.duplicate(event);
    return structuredClone(event);
  }
  duplicate(event: EventOccurrence) { for (const live of this.streams.values()) if (live.ready && live.request.params.arguments.jobId === event.data.jobId) this.write(live, "event", event); }
  notice(kind: string, params: Record<string, unknown>, id?: string) {
    for (const live of this.streams.values()) if (!id || live.request.id === id) this.write(live, kind, params);
  }
  raw(message: unknown, id?: string) { for (const live of this.streams.values()) if (!id || live.request.id === id) live.response.write(`data: ${JSON.stringify(message)}\n\n`); }
  comment() { for (const live of this.streams.values()) live.response.write(": synthetic keepalive, not an Events heartbeat\n\n"); }
  gap() { this.notice("active", { cursor: this.cursor(), truncated: true }); }
  stopHeartbeats() { for (const live of this.streams.values()) clearInterval(live.timer); this.options.heartbeatMs = 0; }
  drop() { for (const live of this.streams.values()) live.response.destroy(); }
  finish(id?: string) {
    for (const live of [...this.streams.values()]) if (!id || live.request.id === id) {
      live.response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: live.request.id, result: { resultType: "complete", _meta: {} } })}\n\n`);
      live.response.end();
    }
  }
  async close() {
    for (const live of this.streams.values()) { clearInterval(live.timer); live.response.destroy(); }
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
