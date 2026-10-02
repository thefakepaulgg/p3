import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/client";
import { z } from "zod";
import { ReferenceServer } from "../reference/server.ts";
import { EventsClient } from "../src/stream-client.ts";
import { delay, waitFor } from "./helpers.ts";

test("real POST/SSE outlives the unmodified SDK default 60s request timer", {
  skip: process.env.MCP_EVENTS_LONG_TEST !== "1", timeout: 75_000,
}, async (t) => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MSEC, 60_000);
  const server = await ReferenceServer.start({ heartbeatMs: 200 });
  t.after(() => server.close());
  const client = await EventsClient.connectLocal(server.url);
  t.after(() => client.close());
  await client.listEvents();
  const ids: string[] = [];
  const stream = client.openStream({ name: "job.completed", arguments: { jobId: "long" }, cursor: null }, {
    heartbeatMs: 1000, onNotice: n => { if (n.kind === "event") ids.push(n.event.eventId); },
  });
  await stream.opened;
  let closed = false;
  void stream.closed.then(() => { closed = true; });
  const started = Date.now();
  // The ordinary SDK call genuinely hits its default timer, while Events never enters that timer map.
  await assert.rejects(client.request({ method: "test/hang" }, z.object({})), /timed out|timeout/i);
  await delay(1500);
  assert.ok(Date.now() - started >= 61_000);
  assert.equal(closed, false);
  server.emit("long", "after-default-timeout");
  await waitFor(() => ids.length === 1);
  assert.deepEqual(ids, ["after-default-timeout"]);
  stream.close();
  await waitFor(() => server.activeCount === 0);
  t.diagnostic(`Stream delivered after ${Date.now() - started}ms; ordinary SDK default request timed out`);
});
