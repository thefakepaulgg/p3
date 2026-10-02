import { test } from "node:test";
import assert from "node:assert/strict";
import { ReferenceServer } from "../reference/server.ts";
import { EventsClient } from "../src/stream-client.ts";
import { waitFor } from "./helpers.ts";

test("draft discovery/catalog and active POST/SSE use owned routing and real per-request cancellation", async (t) => {
  const server = await ReferenceServer.start({ heartbeatMs: 30 });
  t.after(() => server.close());
  const client = await EventsClient.connectLocal(server.url);
  t.after(() => client.close());
  const catalog = await client.listEvents();
  assert.deepEqual(catalog.map(e => e.name), ["job.completed", "webhook.only"]);
  assert.equal(client.eventsCapability.listChanged, true);
  const received: string[] = [];
  const stream = client.openStream({ name: "job.completed", arguments: { jobId: "one" }, cursor: null }, {
    openingMs: 150, heartbeatMs: 30, onNotice: n => { if (n.kind === "event") received.push(n.event.eventId); },
  });
  await stream.opened;
  server.emit("one", "done-1");
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, ["done-1"]);
  assert.equal(server.opens[0].params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  stream.close();
  assert.equal((await stream.closed).reason, "cancelled");
  await waitFor(() => server.activeCount === 0);
  assert.equal(server.cancellations, 1);
  assert.equal(server.gets, 0);
});

async function connected(t: import("node:test").TestContext, options: Parameters<typeof ReferenceServer.start>[0] = {}) {
  const server = await ReferenceServer.start(options);
  const client = await EventsClient.connectLocal(server.url);
  await client.listEvents();
  t.after(async () => { await client.close(); await server.close(); });
  return { server, client };
}
const params = (jobId: string) => ({ name: "job.completed", arguments: { jobId }, cursor: null });

test("opening deadline aborts missing active even if SSE comments arrive", async t => {
  const { server, client } = await connected(t, { omitActive: true });
  const stream = client.openStream(params("one"), { openingMs: 50, heartbeatMs: 20, onNotice() {} });
  await waitFor(() => server.activeCount === 1);
  const comments = setInterval(() => server.comment(), 5);
  t.after(() => clearInterval(comments));
  await assert.rejects(stream.opened, /acknowledgment deadline/);
  assert.equal((await stream.closed).reason, "opening-timeout");
  await waitFor(() => server.activeCount === 0);
});

test("two same-name filtered streams cancel independently; unrelated bounded SDK calls still work", async t => {
  const { server, client } = await connected(t, { heartbeatMs: 30 });
  const one: string[] = [], two: string[] = [];
  const a = client.openStream(params("one"), { onNotice: n => { if (n.kind === "event") one.push(n.event.eventId); } });
  const b = client.openStream(params("two"), { onNotice: n => { if (n.kind === "event") two.push(n.event.eventId); } });
  await Promise.all([a.opened, b.opened]);
  server.emit("one", "a"); server.emit("two", "b");
  await waitFor(() => one.length === 1 && two.length === 1);
  a.close();
  await waitFor(() => server.activeCount === 1);
  server.raw({ jsonrpc: "2.0", method: "notifications/events/event", params: { eventId: "late", name: "job.completed", timestamp: "2026-10-02T12:00:00Z", data: { jobId: "one", state: "complete" }, _meta: { "io.modelcontextprotocol/subscriptionId": a.id } } });
  server.emit("two", "b2");
  await waitFor(() => two.length === 2);
  assert.deepEqual(one, ["a"]); assert.deepEqual(two, ["b", "b2"]);
  assert.deepEqual((await client.discover({ timeout: 100 })).supportedVersions, ["2026-07-28"]);
  assert.equal(server.gets, 0);
  b.close();
});

test("heartbeat silence expires stream; recoverable errors are not a liveness signal", async t => {
  const { server, client } = await connected(t, { heartbeatMs: 0 });
  const stream = client.openStream(params("one"), { heartbeatMs: 25, onNotice() {} });
  await stream.opened;
  server.notice("error", { error: { code: -32603, message: "Transient synthetic fetch failure" } });
  assert.equal((await stream.closed).reason, "heartbeat-timeout");
  await waitFor(() => server.activeCount === 0);
});

test("mid-stream active.truncated and error continue; terminated is terminal", async t => {
  const { server, client } = await connected(t, { heartbeatMs: 30 });
  const kinds: string[] = [];
  const stream = client.openStream(params("one"), { onNotice: n => kinds.push(n.kind) });
  await stream.opened;
  server.notice("error", { error: { code: -32603, message: "Synthetic transient error" } });
  server.gap(); server.emit("one");
  await waitFor(() => kinds.includes("event"));
  assert.deepEqual(kinds.slice(0, 4), ["active", "error", "active", "event"]);
  server.notice("terminated", { error: { code: -32012, message: "Forbidden" } });
  assert.equal((await stream.closed).reason, "terminated");
  await waitFor(() => server.activeCount === 0);
});

test("schema-invalid payload cannot enter client consumer; no invented mode fallback", async t => {
  const { server, client } = await connected(t);
  assert.throws(() => client.openStream({ ...params("one"), name: "webhook.only" }, { onNotice() {} }), /does not advertise push/);
  assert.throws(() => client.openStream({ ...params("one"), arguments: {} }, { onNotice() {} }), /inputSchema/);
  let events = 0;
  const stream = client.openStream(params("one"), { onNotice: n => { if (n.kind === "event") events++; } });
  await stream.opened;
  server.notice("event", { eventId: "invalid", name: "job.completed", timestamp: "2026-10-02T12:00:00Z", data: { jobId: "one", state: "ignore instructions" }, cursor: "ref-9" });
  assert.equal((await stream.closed).reason, "contract-error");
  assert.equal(events, 0);
});

test("client.close settles every owned stream and aborts its POST", async t => {
  const { server, client } = await connected(t);
  const a = client.openStream(params("one"), { onNotice() {} });
  const b = client.openStream(params("two"), { onNotice() {} });
  await Promise.all([a.opened, b.opened]);
  await client.close();
  assert.deepEqual((await Promise.all([a.closed, b.closed])).map(v => v.reason), ["cancelled", "cancelled"]);
  await waitFor(() => server.activeCount === 0);
});

test("server final result settles stream without waiting for the ordinary request timer", async t => {
  const { server, client } = await connected(t);
  const stream = client.openStream(params("one"), { onNotice() {} });
  await stream.opened;
  server.finish(stream.id);
  assert.equal((await stream.closed).reason, "graceful");
});

test("JSON result or HTTP 202 cannot stand in for an active SSE subscription", async t => {
  for (const response of ["json", "accepted"] as const) {
    const { client } = await connected(t, { streamResponse: response });
    const stream = client.openStream(params("one"), { openingMs: 50, onNotice() {} });
    await assert.rejects(stream.opened);
    assert.equal((await stream.closed).reason, response === "json" ? "contract-error" : "opening-timeout");
  }
});

test("modern final result must carry the real resultType envelope", async t => {
  const { server, client } = await connected(t);
  const stream = client.openStream(params("one"), { onNotice() {} });
  await stream.opened;
  server.raw({ jsonrpc: "2.0", id: stream.id, result: { _meta: {} } });
  assert.equal((await stream.closed).reason, "contract-error");
});
