import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { registerRoutedSessionIdentity } from "./session-identity.ts";
import { setHerdrTestTransportForTests, verifyTaskAgent } from "./herdr.ts";

const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
afterEach(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });

test("a routed worker publishes its own identity over Herdr's socket without the account integration", async () => {
  setHerdrTestTransportForTests(undefined);
  const root = mkdtempSync(join(tmpdir(), "p3-session-")); const socket = join(root, "herdr.sock"); const path = join(root, "session.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "owned-session", cwd: root }) + "\n");
  const requests: any[] = []; const agent: any = { pane_id: "w1:p2", terminal_id: "terminal" };
  const server = createServer(client => {
    let input = ""; client.setEncoding("utf8"); client.on("data", chunk => {
      input += chunk; if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n"))); requests.push(request);
      if (request.method === "pane.report_agent_session") agent.agent_session = { value: request.params.agent_session_path };
      client.end(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: socket });
  const handlers = new Map<string, Function>();
  const pi: any = { on: (event: string, handler: Function) => handlers.set(event, handler) };
  let savedPath: string | undefined;
  const ctx: any = { mode: "tui", sessionManager: { getSessionFile: () => savedPath } };
  const task: any = { paneId: "w1:p2", terminalId: "terminal", sessionId: "owned-session" };
  try {
    registerRoutedSessionIdentity(pi);
    expect(() => verifyTaskAgent(task, agent)).toThrow("session identity"); // Exact live symptom.
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    expect(requests).toHaveLength(0); // Lazy file creation needs the first-turn hook.
    savedPath = path;
    await handlers.get("agent_start")!({}, ctx);
    expect(() => verifyTaskAgent(task, agent)).not.toThrow();
    expect(requests[0].method).toBe("pane.report_agent_session");
    expect(requests[0].params).toMatchObject({ pane_id: "w1:p2", source: "p3:routed-session", agent: "pi", agent_session_path: path });
    expect(requests.every(r => r.method === "pane.report_agent_session")).toBe(true); // No prompt, tool or settings mutation.
    const next = join(root, "new.jsonl"); writeFileSync(next, JSON.stringify({ type: "session", id: "different" }) + "\n"); savedPath = next;
    await handlers.get("session_start")!({ reason: "new" }, ctx);
    expect(requests[1].params.session_start_source).toBe("new");
    expect(requests[1].params.seq).toBeGreaterThan(requests[0].params.seq);
    expect(() => verifyTaskAgent(task, agent)).toThrow("session identity"); // Real drift is still refused.
    ctx.mode = "rpc"; await handlers.get("agent_start")!({}, ctx); expect(requests).toHaveLength(2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
