import { test } from "node:test";
import assert from "node:assert/strict";
import { ReferenceServer } from "../reference/server.ts";
import { BASE_REVISION } from "../src/protocol.ts";

test("reference request-body bound counts UTF-8 bytes before parsing", async () => {
  const server = await ReferenceServer.start();
  try {
    const rpc = { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": BASE_REVISION } } };
    const accepted = await fetch(server.url, { method: "POST", body: JSON.stringify(rpc) });
    assert.equal(accepted.status, 200);
    await accepted.json();
    const body = JSON.stringify({ ...rpc, padding: "😀".repeat(20_000) });
    assert.ok(body.length < 64 * 1024);
    assert.ok(Buffer.byteLength(body) > 64 * 1024);
    const rejected = await fetch(server.url, { method: "POST", body });
    assert.equal(rejected.status, 413);
    await rejected.text();
    assert.deepEqual(server.requests, ["server/discover"]);
  } finally { await server.close(); }
});
