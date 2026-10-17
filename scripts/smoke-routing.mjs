#!/usr/bin/env node
// Opt-in real Pi/Herdr process-boundary checks; only model decisions are simulated.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, symlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
const networkSandbox = "(version 1) (allow default) (deny network*) (allow network* (local unix-socket) (remote unix-socket))";
const repo = fileURLToPath(new URL("../", import.meta.url));
const quote = (args) => args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
const secret = (key) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key);
const inherited = (key) => key.startsWith("HERDR_") && key !== "HERDR_ENV" || /^PI_ROUT(ED|ING)_|^PI_SUBAGENT_/.test(key);
function environment(root, session) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !secret(key) && !inherited(key)));
  Object.assign(env, { HOME: join(root, "home"), ZDOTDIR: join(root, "home"), NODE_OPTIONS: `--require=${join(root, "network-guard.cjs")}`, P3_SMOKE_ROOT: root, XDG_CONFIG_HOME: join(root, "c"), XDG_STATE_HOME: join(root, "s"), HERDR_CONFIG_PATH: join(root, "herdr.toml"), PI_CODING_AGENT_DIR: join(root, "a"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), TMPDIR: join(root, "tmp"), PI_OFFLINE: "1" });
  if (session) env.HERDR_SESSION = session;
  return env;
}
async function run(command, args, env = process.env) {
  const result = await exec(command, args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
async function herdr(args, env) {
  const value = JSON.parse(await run("herdr", args, env));
  if (value.error) throw new Error(JSON.stringify(value.error));
  return value.result ?? value;
}
async function wait(label, observe) {
  const deadline = Date.now() + 120000;
  let last;
  while (Date.now() < deadline) {
    last = await observe();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`${label}: no verified evidence before deadline`);
}
async function entries(path) {
  try {
    if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("Smoke transcript exceeds 8 MiB");
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
const text = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
function correlatedResult(history, tool, predicate = () => true) {
  for (const entry of history) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const call = entry.message.content.find((part) => part.type === "toolCall" && part.name === tool && predicate(part.arguments));
    if (!call) continue;
    const result = history.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id && entry.message.toolName === tool);
    if (result) { assert.equal(result.message.isError, false, `${tool} actually failed`); return result.message; }
  }
}

async function main() {
  assert.equal(process.env.HERDR_ENV, "1", "Run from Herdr; the harness creates its own dedicated host tab");
  assert.ok(process.env.HERDR_WORKSPACE_ID);
  const root = await mkdtemp("/tmp/p3-smoke-");
  const name = `s-${randomUUID().slice(0, 8)}`;
  const env = environment(root, name);
  const cwd = join(root, "fixture");
  const source = join(root, "source");
  const failures = [];
  let complete = false;
  let passed = 0;
  let proxy;
  const connections = new Set();
  const raceEsc = [];
  const proxyErrors = [];
  let hostTab;
  let nestedStarted = false;
  const tabs = new Set();
  try {
    console.log(`Evidence: ${root}`);
    if (process.env.P3_SMOKE_SANDBOX === "1") {
      await run(process.execPath, ["-e", `const net = require("node:net"); const s = net.connect(9, "127.0.0.1"); s.on("connect", () => process.exit(1)); s.on("error", e => process.exit(e.code === "EPERM" || e.code === "EACCES" ? 0 : 2));`]);
      console.log("PASS: OS network sandbox denies TCP; only Unix sockets permitted");
    }
    await Promise.all([source, env.HOME, cwd, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_SESSION_DIR, env.TMPDIR].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    // Never load dirty production source (in particular the user's failover.ts).
    const commit = await run("git", ["-C", repo, "rev-parse", "HEAD"]);
    console.log(`Production source: ${commit} (git archive; no working production overlays)`);
    const archive = await exec("git", ["archive", commit, "extensions", "package.json"], { cwd: repo, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    const tar = join(root, "source.tar"); await writeFile(tar, archive.stdout);
    await run("tar", ["-xf", tar, "-C", source], env);
    await symlink(join(repo, "node_modules"), join(source, "node_modules"));
    await mkdir(join(source, "scripts"));
    await copyFile(join(repo, "scripts", "smoke-routing-provider.ts"), join(source, "scripts", "smoke-routing-provider.ts"));
    await writeFile(join(root, "source-commit.txt"), commit);
    console.log(`Provider SHA256: ${createHash("sha256").update(await readFile(join(source, "scripts/smoke-routing-provider.ts"))).digest("hex")}`);
    await writeFile(join(root, "network-guard.cjs"), `
const allowed = value => { const host = new URL(value).hostname; if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new Error("Smoke denied remote network: " + host); };
const fetch = globalThis.fetch; globalThis.fetch = (url, ...args) => { allowed(typeof url === "string" ? url : url.url ?? String(url)); return fetch(url, ...args); };
for (const module of ["node:http", "node:https"]) { const api = require(module); for (const key of ["request", "get"]) { const fn = api[key]; api[key] = function(url, ...args) { allowed(typeof url === "string" || url instanceof URL ? String(url) : "http://" + (url.hostname ?? url.host ?? "localhost")); return fn.call(this, url, ...args); }; } }
`);
    await copyFile(join(source, "package.json"), join(cwd, "package.json"));
    await run("git", ["init", "--quiet", cwd], env);
    await writeFile(env.HERDR_CONFIG_PATH, "[experimental]\nallow_nested = true\n", { mode: 0o600 });
    await writeFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
      defaultProvider: "smoke-routing", defaultModel: "root", retry: { enabled: false, maxRetries: 0 },
      extensions: [join(source, "extensions", "model-routing.ts"), join(source, "scripts", "smoke-routing-provider.ts")],
    }), { mode: 0o600 });
    await writeFile(join(env.HOME, ".zshrc"), `export PATH=${quote([env.PATH])}\n`);
    // Deliberately omit Herdr's optional account-level Pi integration: routed panes must publish their own identity.
    const clear = Object.keys(process.env).filter((key) => secret(key) || /^PI_ROUT(ED|ING)_|^PI_SUBAGENT_/.test(key)).flatMap((key) => ["--env", `${key}=`]);
    const overrides = ["HOME", "ZDOTDIR", "NODE_OPTIONS", "P3_SMOKE_ROOT", "HERDR_CONFIG_PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "TMPDIR", "PI_OFFLINE"].flatMap((key) => ["--env", `${key}=${env[key]}`]);
    const host = await herdr(["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID, "--cwd", cwd, "--label", name, "--no-focus", ...overrides, ...clear], process.env);
    hostTab = host.tab?.tab_id;
    assert.ok(hostTab && host.root_pane?.pane_id, "Missing exact owned host identities");
    nestedStarted = true;
    await run("herdr", ["pane", "run", host.root_pane.pane_id, quote([process.execPath, fileURLToPath(import.meta.url), "--nested-host", name, root])]);
    const first = await wait("isolated Herdr readiness", async () => {
      try {
        const result = await herdr(["pane", "list"], env);
        return result.panes?.find((pane) => pane.workspace_id);
      } catch { return undefined; }
    });
    nestedStarted = true;
    const workspace = first.workspace_id;
    // Transparent local socket relay: all operations execute on real Herdr. Only the
    // owned race fixture delays Esc until its already-running worker finishes.
    const actualSocket = join(env.XDG_CONFIG_HOME, "herdr", "sessions", name, "herdr.sock");
    const proxySocket = join(root, "herdr-proxy.sock");
    proxy = createServer(client => {
      connections.add(client); client.once("close", () => connections.delete(client));
      client.on("error", () => {});
      let buffer = ""; client.setEncoding("utf8");
      client.on("data", async chunk => {
        buffer += chunk; if (!buffer.includes("\n")) return; client.removeAllListeners("data");
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          let raceBoundary;
          if (request.method === "agent.send_keys" && request.params.keys.includes("esc")) {
            let race;
            try { race = JSON.parse(await readFile(join(root, "race.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
            if (race && [race.agent, race.pane].includes(request.params.target)) {
              await writeFile(join(root, `release-${race.id}`), "release only owned race");
              const receipt = await wait("real result before cancellation forwarding", async () => { const value = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", race.id, "outcome.json"), "utf8")); return value.outcome === "completed" && value; });
              raceBoundary = { request, receipt, forwardedAt: Date.now() };
              raceEsc.push(raceBoundary);
              await writeFile(join(root, "race-boundary.json"), JSON.stringify(raceBoundary));
              await rm(join(root, "race.json"));
            }
          }
          const upstream = createConnection(actualSocket);
          connections.add(upstream); upstream.once("close", () => connections.delete(upstream));
          upstream.once("connect", () => upstream.write(buffer));
          let response = "";
          upstream.on("data", data => {
            response += data; client.write(data);
            if (raceBoundary && response.includes("\n")) {
              const ack = JSON.parse(response.slice(0, response.indexOf("\n")));
              raceBoundary.ack = ack;
              // Tracked evidence is persisted before the fixture waits for the result.
              raceBoundary.save = writeFile(join(root, "race-boundary.json"), JSON.stringify({ ...raceBoundary, save: undefined }));
            }
          });
          upstream.on("end", () => client.end()); client.once("close", () => upstream.destroy());
          upstream.on("error", error => client.destroy(error));
        } catch (error) { proxyErrors.push(error.message); client.end(JSON.stringify({ error: { code: "smoke_proxy", message: error.message } }) + "\n"); }
      });
    });
    await new Promise((yes, no) => { proxy.once("error", no); proxy.listen(proxySocket, yes); });
    const start = async (prompt, savedSession) => {
      const created = await herdr(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", "p3 smoke", "--no-focus", "--env", `HERDR_SOCKET_PATH=${proxySocket}`], env);
      const tab = created.tab.tab_id;
      tabs.add(tab);
      const agentName = `smoke-${randomUUID().slice(0, 8)}`;
      try { await herdr(["agent", "start", agentName, "--kind", "pi", "--pane", created.root_pane.pane_id, "--timeout", "30000", "--", "--approve", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", "smoke-routing/root", ...(savedSession ? ["--session", savedSession] : [])], env); } catch (error) {
        await writeFile(join(root, `startup-${agentName}.txt`), await run("herdr", ["pane", "read", created.root_pane.pane_id], env)); throw error;
      }
      await herdr(["agent", "prompt", agentName, prompt, "--wait", "--until", "working", "--until", "done", "--timeout", "10000"], env);
      const info = await herdr(["agent", "get", agentName], env);
      assert.ok(info.agent.agent_session?.value, "Real root session was not published");
      return { tab, path: info.agent.agent_session.value, agent: agentName, pane: created.root_pane.pane_id };
    };
    const finish = async (session, marker) => wait(marker, async () => {
      const history = await entries(session.path);
      return history.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop" && text(entry.message).startsWith(marker)) ? history : undefined;
    });

    const check = async (label, test) => {
      try { await test(); passed++; console.log(`PASS: ${label}`); }
      catch (error) { failures.push(`${label}: ${error.stack ?? error}`); console.error(`FAIL: ${label}: ${error.message}`); await writeFile(join(root, "failures.json"), JSON.stringify(failures, null, 2)); }
    };
    const manifest = async session => JSON.parse(await readFile(join(env.PI_CODING_AGENT_SESSION_DIR, `routing-pane-${session.pane.replaceAll(":", "_")}.json`), "utf8"));
    const taskFor = async (session, id) => (await manifest(session)).tasks.find(t => t.assignmentId === id);
    const receiptFor = async id => JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", id, "outcome.json"), "utf8"));
    const traceFor = async id => (await entries(join(root, "trace.jsonl"))).filter(e => e.assignment === id);
    const launchCase = async kind => {
      const session = await start(`P3_SMOKE_CASE ${kind} ${randomUUID()}`);
      const history = await finish(session, "P3_SMOKE_CASE_READY");
      const launch = correlatedResult(history, "subagent");
      assert.ok(launch?.details?.handle); return { session, launch: launch.details };
    };
    const completed = async (session, id) => wait("actual completion receipt", async () => {
      const task = await taskFor(session, id);
      return task?.completionNotifiedAt && !task.pendingCompletion && task.state === "completed" ? task : undefined;
    });
    const control = async (session, args, marker = randomUUID()) => {
      await herdr(["agent", "prompt", session.agent, `P3_SMOKE_CONTROL ${JSON.stringify({ args, marker })}`], env);
      const history = await finish(session, `P3_SMOKE_CONTROL_OK ${marker}`);
      const index = history.findLastIndex(e => e.type === "message" && e.message.role === "user" && text(e.message).includes(marker));
      const result = history.slice(index).find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "subagent_control");
      assert.ok(result, "Control did not execute a real tool"); return result.message;
    };
    await check("baseline", async () => {
    const success = await start(`P3_SMOKE_START SUCCESS ${randomUUID()}`);
    let history = await finish(success, "P3_SMOKE_SUCCESS_OK");
    const launch = correlatedResult(history, "subagent");
    assert.ok(launch?.details?.assignmentId, "No actual delegated assignment ID");
    const id = launch.details.assignmentId;
    const directory = join(env.PI_CODING_AGENT_DIR, "state", "routed-assignments", id);
    const receipt = JSON.parse(await readFile(join(directory, "outcome.json"), "utf8"));
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.assignmentId, id);
    assert.equal(receipt.requestId, id);
    assert.equal(receipt.sessionId, launch.details.sessionId);
    assert.equal(receipt.terminalId, launch.details.terminalId);
    assert.equal(receipt.paneId, launch.details.paneId);
    const output = await readFile(join(directory, "output.md"), "utf8");
    assert.equal(createHash("sha256").update(output).digest("hex"), receipt.resultHash);
    assert.equal((await readFile(join(directory, "output.sha256"), "utf8")).trim(), receipt.resultHash);
    const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
    assert.equal(metadata.responseEntryId, receipt.responseEntryId);
    assert.equal(metadata.generation, receipt.generation);
    assert.equal(metadata.sessionId, receipt.sessionId);
    assert.ok(output.includes(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).name));
    const childHistory = await entries(receipt.sessionPath);
    const read = correlatedResult(childHistory, "read");
    assert.ok(read, "Worker never executed the real read tool");
    assert.ok(childHistory.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "write" && entry.message.isError), "Forbidden write was not demonstrably rejected");
    await assert.rejects(access(join(cwd, "readonly-canary.txt")), { code: "ENOENT" });
    assert.ok(history.some((entry) => entry.type === "custom_message" && entry.customType === "subagent-completion" && entry.details?.assignmentId === id), "Completion never entered the parent transcript");
    history = await wait("receipt and automatic pane cleanup", async () => {
      const current = await entries(success.path);
      const task = await taskFor(success, id);
      if (task?.error?.startsWith("Result delivered; retained pane")) throw new Error(task.error);
      return task?.completionNotifiedAt && task.paneClosedAt && !task.pendingCompletion ? current : undefined;
    });
    assert.equal(correlatedResult(history, "subagent_control", (args) => args.action === "result")?.details?.durable, true);
    assert.ok((await entries(success.path)).filter(e => e.customType === "routed-task" && e.data?.assignmentId === id).at(-1)?.data.paneClosedAt, "Closure missing from durable task history");
    assert.ok(!(await herdr(["pane", "list"], env)).panes.some(p => p.pane_id === receipt.paneId), "Cleanup claimed closure but worker pane still exists");
    await herdr(["tab", "close", success.tab], env); tabs.delete(success.tab);
    const restored = await start(`P3_SMOKE_RESTART ${randomUUID()}`, success.path);
    const restoredHistory = await finish(restored, "P3_SMOKE_RESTART_OK");
    const results = restoredHistory.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_control" && entry.message.details?.durable === true);
    assert.ok(results.length >= 2, "No new actual result retrieval after primary restart");
    assert.equal(text(results.at(-1).message), output.slice(0, 12000));
    assert.equal(restoredHistory.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-completion" && entry.details?.assignmentId === id).length, 1, "Restart redelivered an already received completion");

    const failure = await start(`P3_SMOKE_START ERROR ${randomUUID()}`);
    const failedHistory = await finish(failure, "P3_SMOKE_ERROR_OK");
    const failedLaunch = correlatedResult(failedHistory, "subagent");
    const failedId = failedLaunch.details.assignmentId;
    const failed = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "state", "routed-assignments", failedId, "outcome.json"), "utf8"));
    assert.equal(failed.outcome, "error");
    assert.equal(failed.resultHash, undefined);
    await assert.rejects(access(join(env.PI_CODING_AGENT_DIR, "state", "routed-assignments", failedId, "output.md")), { code: "ENOENT" });
    assert.equal(correlatedResult(failedHistory, "subagent_control", (args) => args.action === "status")?.details?.task?.state, "failed");
    assert.ok(!failedHistory.some((entry) => entry.type === "custom_message" && entry.customType === "subagent-completion" && entry.details?.assignmentId === failedId));
    });
    // Boundary cases run independently even when the baseline reports a production blocker.
    await check("literal auto uses policy and complete usage is not missing", async () => {
      const { session, launch } = await launchCase("AUTO");
      const task = await completed(session, launch.assignmentId);
      assert.equal(task.routeExplicit, false);
      assert.equal(task.route, "sol");
      assert.equal(task.model, "openai-codex/gpt-6.1-sol");
      assert.equal(task.costKnown, true); assert.equal(task.costComplete, true);
      assert.ok(task.estimatedCost > 0);
      const snapshot = await manifest(session);
      assert.equal(snapshot.missingCostSources, 0); assert.equal(snapshot.sessionCostComplete, true);
      const receipt = await receiptFor(launch.assignmentId);
      const child = await entries(receipt.sessionPath);
      assert.ok(correlatedResult(child, "read"), "Automatic worker did not execute the actual read");
      assert.ok((await traceFor(launch.assignmentId)).some(event => event.event === "auto_provider"));
    });

    await check("durable ask/reply stays in same awaited tool", async () => {
      const { session, launch } = await launchCase("ASK");
      const id = launch.assignmentId;
      const askPath = join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", id, "ask.json");
      const ask = await wait("durable waiting ask", async () => { try { const a = JSON.parse(await readFile(askPath, "utf8")); return a.status === "waiting" && a; } catch (e) { if (e.code !== "ENOENT") throw e; } });
      const before = await receiptFor(id);
      const pendingHistory = await entries(before.sessionPath);
      const asks = pendingHistory.flatMap(e => e.message?.role === "assistant" ? e.message.content.filter(p => p.type === "toolCall" && p.name === "ask_parent") : []);
      assert.equal(asks.length, 1);
      assert.ok(!pendingHistory.some(e => e.message?.role === "toolResult" && e.message.toolCallId === asks[0].id));
      await sleep(800);
      assert.equal((await receiptFor(id)).outcome, "running");
      const pendingResult = await control(session, { action: "result", handle: launch.handle });
      assert.ok(!pendingResult.isError && !pendingResult.details?.durable, "Pending question exposed success");
      assert.ok(!(await entries(session.path)).some(e => e.customType === "subagent-completion" && e.details?.assignmentId === id));
      await assert.rejects(access(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", id, "output.md")), { code: "ENOENT" });
      const answer = `exact-answer-${randomUUID()}`;
      const reply = await control(session, { action: "reply", handle: launch.handle, ask_id: ask.id, message: answer });
      assert.equal(reply.isError, false, text(reply));
      await completed(session, id);
      const after = await receiptFor(id); const history = await entries(after.sessionPath);
      assert.equal(after.sessionId, before.sessionId); assert.equal(after.requestId, before.requestId); assert.equal(after.generation, before.generation);
      const result = correlatedResult(history, "ask_parent");
      assert.equal(result.toolCallId, asks[0].id); assert.equal(text(result), answer); assert.equal(result.details.askId, ask.id);
      assert.equal(JSON.parse(await readFile(askPath, "utf8")).status, "consumed");
      assert.deepEqual(history.filter(e => e.message?.role === "user"), pendingHistory.filter(e => e.message?.role === "user"), "Reply replayed a user prompt");
      assert.equal(history.flatMap(e => e.message?.role === "assistant" ? e.message.content.filter(p => p.type === "toolCall" && p.name === "ask_parent") : []).length, 1);
    });

    await check("durable pending question survives parent absence and fresh pane", async () => {
      const { session, launch } = await launchCase("ASK");
      const id = launch.assignmentId;
      assert.notEqual(launch.tabId, session.tab, "Parent close would touch worker");
      const askPath = join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", id, "ask.json");
      const ask = await wait("question delivered before parent absence", async () => {
        const task = await taskFor(session, id);
        return task?.askDeliveredId && JSON.parse(await readFile(askPath, "utf8"));
      });
      assert.equal(ask.status, "waiting");
      const before = await receiptFor(id); const childBefore = await entries(before.sessionPath);
      const parentBefore = await entries(session.path);
      const questions = rows => rows.filter(e => e.customType === "subagent-question" && e.details?.askId === ask.id);
      assert.equal(questions(parentBefore).length, 1);
      const tool = childBefore.flatMap(e => e.message?.role === "assistant" ? e.message.content.filter(p => p.type === "toolCall" && p.name === "ask_parent") : []);
      assert.equal(tool.length, 1);
      await herdr(["tab", "close", session.tab], env); tabs.delete(session.tab);
      await rm(join(env.PI_CODING_AGENT_SESSION_DIR, `routing-pane-${session.pane.replaceAll(":", "_")}.json`), { force: true });
      await sleep(500);
      assert.equal((await receiptFor(id)).outcome, "running");
      const agent = await herdr(["agent", "get", launch.agent], env); assert.equal(agent.agent.pane_id, launch.paneId);
      assert.equal(JSON.parse(await readFile(askPath, "utf8")).id, ask.id);
      const marker = randomUUID();
      const restored = await start(`P3_SMOKE_CONTROL ${JSON.stringify({ args: { action: "status", handle: launch.handle }, marker })}`, session.path);
      await finish(restored, `P3_SMOKE_CONTROL_OK ${marker}`);
      assert.notEqual(restored.pane, session.pane);
      assert.equal(await realpath(restored.path), await realpath(session.path), "Parent resumed a different session file");
      const parentAfter = await entries(restored.path);
      assert.equal(parentAfter[0].id, parentBefore[0].id, "Parent resumed a different saved session");
      assert.equal(questions(parentAfter).length, 1, "Parent restart duplicated delivered question");
      assert.ok(!parentAfter.some(e => e.customType === "subagent-completion" && e.details?.assignmentId === id));
      const answer = `after-parent-restart-${randomUUID()}`;
      const reply = await control(restored, { action: "reply", handle: launch.handle, ask_id: ask.id, message: answer });
      assert.equal(reply.isError, false, text(reply)); await completed(restored, id);
      const after = await receiptFor(id); const childAfter = await entries(after.sessionPath);
      assert.equal(after.sessionId, before.sessionId); assert.equal(after.requestId, before.requestId); assert.equal(after.generation, before.generation); assert.equal(after.paneId, before.paneId);
      const result = correlatedResult(childAfter, "ask_parent"); assert.equal(result.toolCallId, tool[0].id); assert.equal(text(result), answer);
      assert.deepEqual(childAfter.filter(e => e.message?.role === "user"), childBefore.filter(e => e.message?.role === "user"), "Parent restart replayed a worker prompt");
      assert.equal(questions(await entries(restored.path)).length, 1);
    });

    await check("exact saved-session resume with disjoint nonzero usage", async () => {
      const { session, launch } = await launchCase("RESUME");
      await completed(session, launch.assignmentId);
      await wait("closed original executor", async () => (await taskFor(session, launch.assignmentId))?.paneClosedAt);
      const original = await receiptFor(launch.assignmentId);
      await wait("original process exited", async () => { try { process.kill(original.workerPid, 0); return false; } catch (e) { if (e.code === "ESRCH") return true; throw e; } });
      const beforeBytes = (await stat(original.sessionPath)).size;
      const before = await entries(original.sessionPath);
      const resumed = await control(session, { action: "resume", handle: launch.handle, message: `P3_SMOKE_FOLLOWUP ${randomUUID()}` });
      assert.equal(resumed.isError, false, text(resumed));
      const next = resumed.details;
      assert.notEqual(next.assignmentId, launch.assignmentId); assert.notEqual(next.handle, launch.handle); assert.notEqual(next.paneId, launch.paneId);
      assert.equal(next.sessionId, original.sessionId);
      await completed(session, next.assignmentId);
      const receipt = await receiptFor(next.assignmentId); const after = await entries(receipt.sessionPath);
      assert.equal(await realpath(receipt.sessionPath), await realpath(original.sessionPath), "Worker resumed a different session file");
      assert.deepEqual(after.slice(0, before.length), before, "Saved history changed");
      const added = after.slice(before.length);
      const users = added.filter(e => e.message?.role === "user");
      assert.equal(users.length, 1); assert.ok(text(users[0].message).includes("P3_SMOKE_FOLLOWUP")); assert.ok(!text(users[0].message).includes("P3_SMOKE_OBJECTIVE"));
      assert.ok(!added.some(e => e.message?.role === "assistant" && e.message.content.some(p => p.type === "toolCall")), "Historical tool replayed");
      const oldTask = await taskFor(session, launch.assignmentId); const newTask = await taskFor(session, next.assignmentId);
      assert.equal(newTask.usageStartOffset, beforeBytes); assert.ok(oldTask.usageOffset <= newTask.usageStartOffset);
      const cost = rows => rows.filter(e => e.message?.role === "assistant").reduce((sum,e) => sum + e.message.usage.cost.total, 0);
      assert.ok(cost(before) > 0 && cost(added) > 0, "Usage test must be nonzero");
      assert.equal(newTask.estimatedCost, cost(added)); assert.equal(oldTask.estimatedCost, cost(before));
    });

    await check("interrupt settles held operation before replacement", async () => {
      const { session, launch } = await launchCase("INTERRUPT");
      await wait("actual held tool", async () => (await traceFor(launch.assignmentId)).some(e => e.event === "hold_enter"));
      const before = await receiptFor(launch.assignmentId);
      const response = await control(session, { action: "interrupt", handle: launch.handle, message: `P3_SMOKE_REPLACEMENT ${randomUUID()}` });
      assert.equal(response.isError, false, text(response));
      await completed(session, launch.assignmentId);
      const trace = await traceFor(launch.assignmentId);
      const returned = trace.find(e => e.event === "hold_abort_return");
      const settled = trace.find(e => e.event === "agent_settled" && e.at >= returned?.at);
      const replacement = trace.find(e => e.event === "provider" && e.users.some(u => u.includes("P3_SMOKE_REPLACEMENT")));
      assert.ok(returned && settled && replacement); assert.ok(replacement.at >= settled.at);
      const after = await receiptFor(launch.assignmentId);
      assert.equal(after.sessionId, before.sessionId); assert.notEqual(after.requestId, before.requestId); assert.ok(after.generation > before.generation);
      const history = await entries(after.sessionPath);
      assert.equal(history.filter(e => e.message?.role === "user" && text(e.message).includes("P3_SMOKE_OBJECTIVE")).length, 1);
      assert.equal(history.filter(e => e.message?.role === "user" && text(e.message).includes("P3_SMOKE_REPLACEMENT")).length, 1);
    });

    for (const mixed of [false, true]) await check(`${mixed ? "mixed" : "human"} editor draft refuses interrupt replacement`, async () => {
      const { session, launch } = await launchCase(mixed ? "MIXED" : "HUMAN");
      await wait("held draft worker", async () => (await traceFor(launch.assignmentId)).some(e => e.event === "hold_enter"));
      const instruction = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", launch.assignmentId, "instruction.json"), "utf8")).text;
      const draft = `${mixed ? instruction + "\n\n" : ""}HUMAN_DRAFT_${randomUUID()}`;
      await writeFile(join(root, `draft-${launch.assignmentId}.json`), JSON.stringify(draft));
      await wait("real UI draft applied", async () => (await traceFor(launch.assignmentId)).some(e => e.event === "draft_applied"));
      const response = await control(session, { action: "interrupt", handle: launch.handle, message: "P3_SMOKE_REPLACEMENT MUST_NOT_SUBMIT" });
      assert.equal(response.isError, true, "Unowned draft was accepted"); assert.match(text(response), /unowned draft|draft.*preserved/);
      const receipt = await receiptFor(launch.assignmentId); assert.equal(receipt.outcome, "aborted");
      const history = await entries(receipt.sessionPath);
      assert.ok(!history.some(e => e.message?.role === "user" && text(e.message).includes("MUST_NOT_SUBMIT")));
      const nonce = randomUUID(); await writeFile(join(root, `probe-${launch.assignmentId}`), nonce);
      const probe = await wait("post-refusal real editor snapshot", async () => {
        try { const p = JSON.parse(await readFile(join(root, `probe-result-${launch.assignmentId}.json`), "utf8")); return p.nonce === nonce && p; }
        catch (e) { if (e.code !== "ENOENT") throw e; }
      });
      assert.equal(probe.editor, draft, "Abort/refusal erased or concatenated a human draft"); assert.equal(probe.idle, true);
    });
    await check("completed result racing Esc is retained without replacement", async () => {
      const { session, launch } = await launchCase("RACE");
      await wait("race worker really held", async () => (await traceFor(launch.assignmentId)).some(e => e.event === "hold_enter"));
      const before = await receiptFor(launch.assignmentId); assert.equal(before.outcome, "running");
      await writeFile(join(root, "race.json"), JSON.stringify({ id: launch.assignmentId, agent: launch.agent, pane: launch.paneId }));
      const response = await control(session, { action: "interrupt", handle: launch.handle, message: "P3_SMOKE_REPLACEMENT RACE_MUST_NOT_SUBMIT" });
      assert.equal(response.isError, false, text(response)); assert.match(text(response), /completed before cancellation/);
      assert.equal(raceEsc.length, 1, "Race must intercept exactly one owned Esc");
      await raceEsc[0].save;
      const boundary = JSON.parse(await readFile(join(root, "race-boundary.json"), "utf8"));
      assert.equal(boundary.ack.id, boundary.request.id); assert.ok(boundary.ack.result && !boundary.ack.error, "Forwarded Esc was not acknowledged by real Herdr");
      const trace = await traceFor(launch.assignmentId);
      assert.ok(trace.some(e => e.event === "hold_release")); assert.ok(!trace.some(e => e.event.startsWith("hold_abort")));
      await assert.rejects(access(join(root, "race.json")), { code: "ENOENT" });
      assert.equal(boundary.receipt.outcome, "completed"); assert.equal(boundary.receipt.requestId, before.requestId);
      await completed(session, launch.assignmentId);
      const receipt = await receiptFor(launch.assignmentId);
      assert.equal(receipt.resultHash, boundary.receipt.resultHash); assert.equal(receipt.generation, before.generation);
      const history = await entries(receipt.sessionPath);
      assert.ok(!history.some(e => e.message?.role === "user" && text(e.message).includes("RACE_MUST_NOT_SUBMIT")));
      const output = await control(session, { action: "result", handle: launch.handle });
      assert.equal(output.details?.durable, true); assert.match(text(output), /P3_SMOKE_RACE_RESULT/);
    });
    await check("public streaming abort settles before replacement", async () => {
      const { session, launch } = await launchCase("STREAM");
      await wait("real streamed assistant delta", async () => (await traceFor(launch.assignmentId)).some(e => e.event === "stream_delta"));
      const response = await control(session, { action: "interrupt", handle: launch.handle, message: "P3_SMOKE_REPLACEMENT STREAM" });
      assert.equal(response.isError, false, text(response)); await completed(session, launch.assignmentId);
      const receipt = await receiptFor(launch.assignmentId); const history = await entries(receipt.sessionPath);
      assert.ok(history.some(e => e.message?.role === "assistant" && e.message.stopReason === "aborted" && text(e.message).includes("P3_SMOKE_STREAMING")), "No actual public streaming aborted message");
      const trace = await traceFor(launch.assignmentId); const starts = trace.filter(e => e.event === "stream_provider");
      assert.equal(starts.length, 2); assert.ok(starts[1].at >= trace.find(e => e.event === "agent_settled").at);
    });
    for (const streaming of [false, true]) await check(`unsolicited Esc ${streaming ? "streaming stays interrupted" : "held tool stays error without intent"}`, async () => {
      const { session, launch } = await launchCase(streaming ? "UNSOLICITED_STREAM" : "UNSOLICITED_HOLD");
      await wait("actual unsolicited fixture operation", async () => (await traceFor(launch.assignmentId)).some(e => e.event === (streaming ? "stream_delta" : "hold_enter")));
      await herdr(["agent", "send-keys", launch.agent, "esc"], env);
      const receipt = await wait("unsolicited Esc real settled receipt", async () => { const r = await receiptFor(launch.assignmentId); return r.outcome !== "running" && r; });
      assert.equal(receipt.outcome, streaming ? "aborted" : "error");
      await assert.rejects(access(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", launch.assignmentId, "cancellation.json")), { code: "ENOENT" });
      const history = await entries(receipt.sessionPath);
      const final = history.filter(e => e.message?.role === "assistant").at(-1).message;
      assert.equal(final.stopReason, streaming ? "aborted" : "error");
      if (!streaming) assert.equal(final.errorMessage, "This operation was aborted");
      assert.equal(history.filter(e => e.message?.role === "user").length, 1, "Unsolicited Esc replayed/queued a prompt");
      await assert.rejects(access(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", launch.assignmentId, "output.md")), { code: "ENOENT" });
      await wait("unsolicited status classification", async () => (await taskFor(session, launch.assignmentId))?.state === (streaming ? "interrupted" : "failed"));
    });
    // Native reopening of a completed worker's exact saved Pi file (no task replay, no model call).
    const identities = async () => (await entries(join(root, "trace.jsonl"))).filter(e => e.event === "session_identity");
    const providerCalls = async pid => (await entries(join(root, "trace.jsonl"))).filter(e => ["provider", "auto_provider", "stream_provider"].includes(e.event) && e.pid === pid).length;
    const panes = async () => (await herdr(["pane", "list"], env)).panes;
    const agents = async () => (await herdr(["agent", "list"], env)).agents;
    const sha = buffer => createHash("sha256").update(buffer).digest("hex");
    const artifactHashes = async id => Object.fromEntries(await Promise.all(["output.md", "output.sha256", "outcome.json", "metadata.json"].map(async file => [file, sha(await readFile(join(env.PI_CODING_AGENT_DIR, "state/routed-assignments", id, file)))])));
    const settingsHash = async () => sha(await readFile(join(env.PI_CODING_AGENT_DIR, "settings.json")));
    const rootPid = async session => { const real = await realpath(session.path); for (const e of (await identities()).reverse()) if (e.sessionFile && await realpath(e.sessionFile).catch(() => "") === real) return e.pid; };
    const attachedPids = async (path, excluded) => { const real = await realpath(path); const out = new Set(); for (const e of await identities()) if (e.pid !== excluded && e.reason !== "new" && e.sessionFile && await realpath(e.sessionFile).catch(() => "") === real) out.add(e.pid); return [...out]; };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
    const stateMentions = async needle => { const r = spawnSync("grep", ["-rlF", needle, join(env.PI_CODING_AGENT_DIR, "state"), env.PI_CODING_AGENT_SESSION_DIR], { encoding: "utf8" }); return r.stdout.split("\n").filter(Boolean); };
    const ordinary = e => ["message", "model_change", "thinking_level_change"].includes(e.type);
    const command = async (session, line) => herdr(["agent", "prompt", session.agent, line], env);
    const attachmentFile = (id, file) => join(env.PI_CODING_AGENT_DIR, "state/routed-attachments/records", id, file);
    const presenceOf = async id => JSON.parse(await readFile(attachmentFile(id, "worker.json"), "utf8"));
    const recordOf = async id => JSON.parse(await readFile(attachmentFile(id, "record.json"), "utf8"));
    const claimHeld = async path => access(join(env.PI_CODING_AGENT_DIR, "state/routed-attachments/claims", sha(await realpath(path)))).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
    const usageCost = rows => rows.filter(e => e.type === "message" && e.message.role === "assistant").reduce((sum, e) => sum + e.message.usage.cost.total, 0);
    const windowCost = async (path, from, to) => usageCost((await readFile(path)).subarray(from, to).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
    // A finished NATIVE worker whose executor pane and process are gone: the saved session is attachable.
    const finishedNative = async () => {
      const { session, launch } = await launchCase("NATIVE");
      await completed(session, launch.assignmentId);
      await wait("original executor pane closed", async () => (await taskFor(session, launch.assignmentId))?.paneClosedAt);
      const original = await receiptFor(launch.assignmentId);
      await wait("original worker exited", async () => !alive(original.workerPid));
      return { session, launch, original, task: await taskFor(session, launch.assignmentId), artifacts: await artifactHashes(launch.assignmentId) };
    };
    const openAttachment = async (session, launch, original) => {
      const opened = await control(session, { action: "open", handle: launch.handle });
      assert.equal(opened.isError, false, text(opened));
      const record = opened.details.attachment;
      assert.equal(record.status, "open"); assert.equal(await realpath(record.sessionPath), await realpath(original.sessionPath));
      const identity = await wait("attachment identity", async () => (await identities()).find(e => e.pid === record.workerPid));
      assert.equal(identity.env.PI_ROUTED_ATTACHMENT_ID, record.attachmentId, "Opened PID is not the exact owned attachment");
      await herdr(["agent", "wait", record.agentName, "--until", "idle", "--until", "done", "--timeout", "30000"], env).catch(() => {});
      return { record, identity };
    };
    const manualTurn = async (alias, path, marker = randomUUID().slice(0, 8)) => {
      await herdr(["agent", "prompt", alias, `P3_SMOKE_HUMAN ${marker}`], env);
      await wait(`manual turn ${marker}`, async () => (await entries(path)).some(e => e.message?.role === "assistant" && e.message.stopReason === "stop" && text(e.message).startsWith(`P3_SMOKE_HUMAN_DONE ${marker} WRITE_DENIED`)));
      await herdr(["agent", "wait", alias, "--until", "idle", "--until", "done", "--timeout", "30000"], env).catch(() => {});
      return marker;
    };
    const resumeFollowup = async (session, launch, original) => {
      const before = await entries(original.sessionPath);
      const marker = `P3_SMOKE_FOLLOWUP ${randomUUID()}`;
      const resumed = await control(session, { action: "resume", handle: launch.handle, message: marker });
      assert.equal(resumed.isError, false, text(resumed));
      const next = resumed.details;
      assert.equal(next.sessionId, original.sessionId); assert.notEqual(next.assignmentId, launch.assignmentId);
      await completed(session, next.assignmentId);
      const after = await entries(original.sessionPath);
      assert.deepEqual(after.slice(0, before.length), before, "Resume rewrote saved history");
      const added = after.slice(before.length);
      const users = added.filter(e => e.message?.role === "user").map(e => text(e.message));
      assert.equal(users.length, 1, "Resume submitted more than the explicit follow-up"); assert.ok(users[0].includes(marker)); assert.ok(!users[0].includes("P3_SMOKE_OBJECTIVE") && !users[0].includes("P3_SMOKE_HUMAN"), "Resume replayed earlier input");
      assert.ok(!added.some(e => e.message?.role === "assistant" && e.message.content.some(p => p.type === "toolCall")), "Historical tool replayed on resume");
      assert.equal(after.filter(e => e.message?.role === "user" && text(e.message).includes("P3_SMOKE_OBJECTIVE")).length, 1, "Original task replayed");
      return { next, task: await taskFor(session, next.assignmentId), receipt: await receiptFor(next.assignmentId) };
    };
    let native;
    await check("/subagents open natively reopens exact saved worker file without prompt or model call", async () => {
      const { session, launch } = await launchCase("NATIVE");
      const id = launch.assignmentId;
      await completed(session, id);
      await wait("original executor pane closed", async () => (await taskFor(session, id))?.paneClosedAt);
      const original = await receiptFor(id);
      await wait("original worker exited", async () => !alive(original.workerPid));
      const originalIdentity = (await identities()).find(e => e.pid === original.workerPid);
      assert.ok(originalIdentity, "Original worker identity evidence missing");
      const bytes = await readFile(original.sessionPath); const artifacts = await artifactHashes(id); const settings = await settingsHash();
      const rootProcess = await rootPid(session); const rootCalls = await providerCalls(rootProcess);
      const panesBefore = new Set((await panes()).map(p => p.pane_id));
      const rootBefore = await entries(session.path);
      await command(session, `/subagents open ${launch.handle}`);
      const [pid] = await wait("native attachment Pi on the exact saved file", async () => { const pids = await attachedPids(original.sessionPath, original.workerPid); return pids.length ? pids : undefined; });
      const opened = await wait("single new attachment pane focused", async () => { const added = (await panes()).filter(p => !panesBefore.has(p.pane_id)); return added.length === 1 && added[0].agent_session?.value && added[0].focused ? added[0] : undefined; });
      assert.equal(await realpath(opened.agent_session.value), await realpath(original.sessionPath), "Attachment published a different session");
      assert.notEqual(opened.pane_id, original.paneId, "Attachment reused the closed executor pane");
      const record = await wait("durable attachment record", async () => (await manifest(session)).attachments?.find(a => a.sourceHandle === launch.handle && a.paneId === opened.pane_id && a.status === "open" && a.workerPid));
      assert.equal(await realpath(record.sessionPath), await realpath(original.sessionPath)); assert.equal(record.sessionId, original.sessionId);
      assert.equal(record.workerPid, pid); assert.equal(record.usageStartOffset, bytes.length, "Usage boundary is not the pre-open byte size");
      const agent = (await agents()).find(a => a.pane_id === opened.pane_id);
      assert.equal(agent?.name, record.agentName, "Attachment pane is not addressable by its recorded alias");
      await herdr(["agent", "wait", agent.name, "--until", "idle", "--until", "done", "--timeout", "30000"], env).catch(() => {});
      await sleep(1500);
      const identity = (await identities()).find(e => e.pid === pid);
      assert.ok(identity.argv.includes("--session"), "Attachment did not open an explicit saved session");
      for (const key of ["model", "thinking", "cwd"]) assert.equal(identity[key], originalIdentity[key], `Attachment did not restore ${key}`);
      assert.ok(identity.env.PI_ROUTED_ATTACHMENT_ID && identity.env.PI_ROUTING_MANIFEST, "Attachment identity env missing");
      assert.equal(identity.env.PI_ROUTED_ASSIGNMENT_ID, undefined, "Attachment reused the original assignment lifecycle");
      assert.equal(identity.env.PI_ROUTED_READONLY, originalIdentity.env.PI_ROUTED_READONLY, "Attachment lost the original read-only policy");
      assert.ok(!identity.tools.some(tool => ["write", "edit", "bash"].includes(tool)), `Attachment exposes mutating tools: ${identity.tools}`);
      assert.ok(identity.tools.every(tool => originalIdentity.tools.includes(tool)), `Attachment widened the tool profile: ${identity.tools}`);
      assert.equal(await providerCalls(pid), 0, "Native open made a model call");
      assert.equal(await providerCalls(rootProcess), rootCalls, "/subagents open reached the Root model");
      const rootAfter = await entries(session.path);
      assert.ok(!rootAfter.slice(rootBefore.length).some(e => e.type === "message" && text(e.message).includes("/subagents")), "/subagents was submitted as a prompt");
      const after = await readFile(original.sessionPath);
      assert.ok(after.subarray(0, bytes.length).equals(bytes), "Open rewrote saved history");
      const added = after.subarray(bytes.length).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      assert.ok(!added.some(ordinary), `Open appended ordinary entries: ${added.map(e => e.type)}`);
      console.log(`Native open byte delta before typing: ${after.length - bytes.length} (${added.map(e => e.customType ?? e.type).join(",") || "none"})`);
      assert.deepEqual(await artifactHashes(id), artifacts, "Old result artifacts changed");
      assert.equal(await settingsHash(), settings, "Settings changed");
      assert.ok((await stateMentions(opened.pane_id)).length, "Attachment metadata was not durably recorded");
      native = { session, launch, id, original, originalIdentity, pid, pane: opened.pane_id, alias: agent.name, attachmentId: record.attachmentId, bytes, artifacts, settings, rootProcess, rootCalls, cost: (await taskFor(session, id)).estimatedCost };
    });

    await check("manual turns via exact attachment alias deny write, accept future turns, never wake Root", async () => {
      assert.ok(native, "Native attachment fixture unavailable");
      const { session, id, original, pid, alias, bytes, artifacts, rootProcess, rootCalls } = native;
      const completions = rows => rows.filter(e => e.customType === "subagent-completion" && e.details?.assignmentId === id).length;
      const completionsBefore = completions(await entries(session.path));
      for (const marker of [randomUUID().slice(0, 8), randomUUID().slice(0, 8)]) {
        await herdr(["agent", "prompt", alias, `P3_SMOKE_HUMAN ${marker}`], env);
        await wait(`manual turn ${marker}`, async () => (await entries(original.sessionPath)).some(e => e.message?.role === "assistant" && e.message.stopReason === "stop" && text(e.message).startsWith(`P3_SMOKE_HUMAN_DONE ${marker}`)));
        const history = await entries(original.sessionPath);
        assert.ok(history.some(e => text(e.message).startsWith(`P3_SMOKE_HUMAN_DONE ${marker} WRITE_DENIED`)), "Manual write was not denied");
        assert.ok(history.some(e => e.message?.role === "toolResult" && e.message.toolName === "write" && e.message.isError && history.some(c => c.message?.content?.some?.(p => p.type === "toolCall" && p.id === e.message.toolCallId && p.arguments.path.includes(marker)))), "No actual denied write tool result");
        await assert.rejects(access(join(cwd, `human-canary-${marker}.txt`)), { code: "ENOENT" });
      }
      assert.equal(await providerCalls(pid), 4, "Each manual turn must make exactly two model calls");
      const after = await readFile(original.sessionPath);
      assert.ok(after.subarray(0, bytes.length).equals(bytes), "Manual turns rewrote saved history");
      const history = await entries(original.sessionPath);
      assert.equal(history.filter(e => e.message?.role === "user" && text(e.message).includes("P3_SMOKE_OBJECTIVE")).length, 1, "Original task replayed");
      await sleep(1500);
      assert.equal(completions(await entries(session.path)), completionsBefore, "Manual turn produced an automatic Root completion");
      assert.equal(await providerCalls(rootProcess), rootCalls, "Manual turn woke the Root model");
      assert.deepEqual(await artifactHashes(id), artifacts, "Manual turns changed old result artifacts");
      const task = await taskFor(session, id);
      const usage = await wait("attachment usage refreshed", async () => { const a = (await manifest(session)).attachments?.find(a => a.attachmentId === native.attachmentId); return a?.estimatedCost === 4 && a; });
      console.log(`Attachment usage evidence: ${JSON.stringify({ start: usage.usageStartOffset, offset: usage.usageOffset, cost: usage.estimatedCost, known: usage.costKnown, complete: usage.costComplete, history: bytes.length })}`);
      assert.equal(usage.usageStartOffset, bytes.length, "Attachment usage boundary is not the pre-open byte size");
      assert.equal(usage.costKnown, true); assert.equal(usage.costComplete, true);
      assert.equal(task.estimatedCost, native.cost, "Manual turns changed the completed assignment's usage");
    });

    await check("reopen reuses one writer, refuses resume, survives parent restart, other parent cannot adopt", async () => {
      assert.ok(native, "Native attachment fixture unavailable");
      const { session, launch, original, pid, pane } = native;
      const panesBefore = (await panes()).map(p => p.pane_id).sort();
      const reopen = await control(session, { action: "open", handle: launch.handle });
      assert.equal(reopen.isError, false, text(reopen));
      assert.equal(reopen.details?.attachment?.attachmentId, native.attachmentId, "Second open returned a different attachment");
      assert.equal(reopen.details.paneId, pane);
      assert.deepEqual((await panes()).map(p => p.pane_id).sort(), panesBefore, "Second open spawned a pane");
      assert.deepEqual(await attachedPids(original.sessionPath, original.workerPid), [pid], "Second open spawned a second writer");
      assert.ok((await panes()).find(p => p.pane_id === pane)?.focused, "Second open did not focus the attachment");
      const resume = await control(session, { action: "resume", handle: launch.handle, message: "P3_SMOKE_FOLLOWUP SECOND_WRITER" });
      assert.equal(resume.isError, true, "Resume admitted a second writer while attached");
      assert.ok(!(await entries(original.sessionPath)).some(e => text(e.message).includes("SECOND_WRITER")));
      await herdr(["tab", "close", session.tab], env); tabs.delete(session.tab);
      assert.ok(alive(pid), "Parent exit killed the attachment");
      const marker = randomUUID();
      const restored = await start(`P3_SMOKE_CONTROL ${JSON.stringify({ args: { action: "status", handle: launch.handle }, marker })}`, session.path);
      await finish(restored, `P3_SMOKE_CONTROL_OK ${marker}`);
      native.session = restored;
      const rootBefore = await entries(restored.path);
      // Bare /subagents: selecting the (only) row opens directly, no action menu.
      await command(restored, "/subagents");
      await sleep(1000);
      await herdr(["agent", "send-keys", restored.agent, "enter"], env);
      await wait("restarted parent focuses existing attachment", async () => (await panes()).find(p => p.pane_id === pane)?.focused);
      await sleep(1000);
      assert.deepEqual((await panes()).filter(p => p.tab_id !== restored.tab).map(p => p.pane_id).sort(), panesBefore.filter(p => p !== session.pane).sort(), "Restart spawned a second attachment");
      assert.deepEqual(await attachedPids(original.sessionPath, original.workerPid), [pid]);
      assert.ok(!(await entries(restored.path)).slice(rootBefore.length).some(e => e.type === "message" && text(e.message).includes("/subagents")));
      const other = await start(`P3_SMOKE_CONTROL ${JSON.stringify({ args: { action: "open", handle: launch.handle }, marker: "other" })}`);
      const otherHistory = await finish(other, "P3_SMOKE_CONTROL_OK other");
      assert.equal(otherHistory.find(e => e.message?.role === "toolResult" && e.message.toolName === "subagent_control").message.isError, true, "Other parent adopted the attachment");
      assert.deepEqual(await attachedPids(original.sessionPath, original.workerPid), [pid]);
      await herdr(["tab", "close", other.tab], env); tabs.delete(other.tab);
    });

    await check("close releases claim; /new session drift refuses old identity control", async () => {
      assert.ok(native, "Native attachment fixture unavailable");
      const { session, launch, original, pid, pane } = native;
      const closed = await control(session, { action: "close", handle: launch.handle });
      assert.equal(closed.isError, false, text(closed));
      await wait("attachment pane closed", async () => !(await panes()).some(p => p.pane_id === pane));
      await wait("attachment Pi exited", async () => !alive(pid));
      const reopened = await control(session, { action: "open", handle: launch.handle });
      assert.equal(reopened.isError, false, text(reopened));
      const [next] = await wait("fresh attachment after release", async () => { const p = (await attachedPids(original.sessionPath, original.workerPid)).filter(p => p !== pid); return p.length === 1 && p; });
      const real = await realpath(original.sessionPath);
      const alias = await wait("fresh attachment alias", async () => { for (const a of await agents()) if (a.pane_id !== pane && a.agent_session?.value && await realpath(a.agent_session.value).catch(() => "") === real) return a.name; });
      assert.ok(alias);
      const bytes = await readFile(original.sessionPath);
      await herdr(["agent", "prompt", alias, "/new"], env);
      const drift = await wait("attachment drifted to a new session", async () => (await identities()).find(e => e.pid === next && e.reason === "new"));
      assert.notEqual(await realpath(drift.sessionFile).catch(() => drift.sessionFile), await realpath(original.sessionPath));
      // Authoritative drift evidence is the attached process's own worker.json, not the parent record.
      const attachmentId = await wait("drifted attachment record", async () => (await manifest(session)).attachments?.find(a => a.agentName === alias)?.attachmentId);
      const presence = await wait("drift presence recorded", async () => { const p = await presenceOf(attachmentId); return p.drift && p; });
      assert.equal(presence.pid, next); assert.equal(presence.drift.reason, "new");
      assert.notEqual(presence.drift.sessionId, original.sessionId); assert.notEqual(presence.drift.sessionPath, real);
      const record = await wait("parent reports drift", async () => { const r = await recordOf(attachmentId); return r.error?.includes("left its session") && r; });
      console.log(`Drift record: ${JSON.stringify({ status: record.status, error: record.error, drift: presence.drift })}`);
      const refuse = async phase => {
        for (const action of ["open", "close"]) {
          const refused = await control(session, { action, handle: launch.handle });
          assert.equal(refused.isError, true, `${action} controlled a drifted session (${phase})`);
          console.log(`Drift ${action} refusal (${phase}): ${text(refused).slice(0, 200)}`);
        }
        const resume = await control(session, { action: "resume", handle: launch.handle, message: `P3_SMOKE_FOLLOWUP DRIFT_WRITER` });
        assert.equal(resume.isError, true, `Resume admitted a second writer on a drift-held claim (${phase})`);
        assert.ok(alive(next), `Refused control killed the drifted Pi (${phase})`);
        assert.ok(await claimHeld(original.sessionPath), `Drift released the claim (${phase})`);
      };
      await refuse("after /new");
      // Same process returns to the exact original file via Pi's native session switch: drift stays sticky.
      await herdr(["agent", "prompt", alias, `/p3-smoke-switch ${original.sessionPath}`], env);
      const back = await wait("same process switched back to original file", async () => { for (const e of await identities()) if (e.pid === next && e.reason !== "new" && e.reason !== "startup" && e.sessionFile && await realpath(e.sessionFile).catch(() => "") === real && e.at > drift.at) return e; });
      await wait("Herdr publishes the original session again", async () => { for (const a of await agents()) if (a.name === alias && await realpath(a.agent_session?.value ?? "").catch(() => "") === real) return true; });
      assert.equal(back.session, original.sessionId);
      assert.deepEqual((await presenceOf(attachmentId)).drift, presence.drift, "Return to the original file cleared or rewrote sticky drift");
      await refuse("after return to original");
      const reopenRefusal = await control(session, { action: "open", handle: launch.handle });
      assert.match(text(reopenRefusal), /drift/i, "Open refusal after return is not attributed to recorded drift");
      assert.ok(!(await readFile(original.sessionPath)).toString("utf8").includes("DRIFT_WRITER"), "Refused resume wrote the session");
      assert.ok(alive(next), "Refused control still killed the drifted Pi");
      assert.ok((await readFile(original.sessionPath)).equals(bytes), "Drift wrote the original conversation");
      assert.equal(await settingsHash(), native.settings, "Settings changed");
      assert.deepEqual(await artifactHashes(native.id), native.artifacts);
      // The human closes it from its own pane; the parent then finalizes only on exit + inventory absence.
      await herdr(["agent", "prompt", alias, "/quit"], env);
      await wait("drifted Pi exited from its own pane", async () => !alive(next));
      const final = await wait("parent finalized drifted attachment", async () => { const r = await recordOf(attachmentId); return r.status === "closed" && r; });
      assert.equal(final.costComplete, false, "Drifted window claimed complete usage"); assert.match(final.error, /drift/);
      assert.equal(await claimHeld(original.sessionPath), false, "Claim retained after proven exit");
      console.log(`Drift finalization: ${JSON.stringify({ status: final.status, error: final.error, cost: final.estimatedCost, complete: final.costComplete })}`);
    });

    await check("SIGKILLed attachment: parent proves exit and absence, releases claim, closes partial; bounded resume follows without replay", async () => {
      const { session, launch, original, task, artifacts } = await finishedNative();
      const { record } = await openAttachment(session, launch, original);
      const pid = record.workerPid;
      await manualTurn(record.agentName, original.sessionPath);
      const presence = await presenceOf(record.attachmentId);
      assert.equal(presence.pid, pid); assert.equal(presence.paneId, record.paneId); assert.equal(presence.shutdown, undefined);
      assert.ok((await identities()).some(e => e.pid === pid && e.env.PI_ROUTED_ATTACHMENT_ID === record.attachmentId), "Refusing to signal a PID not proven to be this fixture's attachment");
      process.kill(pid, "SIGKILL");
      await wait("killed attachment exited", async () => !alive(pid));
      const closed = await wait("parent refresh finalized killed attachment", async () => { const r = await recordOf(record.attachmentId); return r.status === "closed" && r; });
      const inventory = await agents();
      assert.ok(!inventory.some(a => a.pane_id === record.paneId || a.terminal_id === record.terminalId || a.name === record.agentName), "Finalized while Herdr still represents the attachment");
      assert.equal(closed.costComplete, false, "Killed window claimed complete usage"); assert.equal(closed.costKnown, true);
      assert.match(closed.error, /partial/);
      const size = (await stat(original.sessionPath)).size;
      assert.equal(closed.usageStartOffset, record.usageStartOffset); assert.ok(closed.usageOffset <= size);
      assert.equal(closed.estimatedCost, await windowCost(original.sessionPath, closed.usageStartOffset, closed.usageOffset)); assert.ok(closed.estimatedCost > 0);
      assert.equal(await claimHeld(original.sessionPath), false, "Claim retained after proven exit and absence");
      assert.equal((await manifest(session)).attachments.find(a => a.attachmentId === record.attachmentId)?.status, "closed");
      console.log(`Killed attachment: ${JSON.stringify({ pid, status: closed.status, cost: closed.estimatedCost, complete: closed.costComplete, error: closed.error })}`);
      const { task: resumed } = await resumeFollowup(session, launch, original);
      assert.ok(resumed.usageStartOffset >= closed.usageOffset, "Resumed window overlaps the killed attachment window");
      assert.ok(resumed.estimatedCost > 0);
      assert.equal((await taskFor(session, launch.assignmentId)).estimatedCost, task.estimatedCost, "Original task usage changed");
      assert.deepEqual(await artifactHashes(launch.assignmentId), artifacts, "Original result artifacts changed");
    });

    await check("open, manual turn, close, bounded resume: disjoint immutable task, attachment and resumed windows; total counts each once", async () => {
      const { session, launch, original, task, artifacts } = await finishedNative();
      const { record } = await openAttachment(session, launch, original);
      await manualTurn(record.agentName, original.sessionPath);
      const closing = await control(session, { action: "close", handle: launch.handle });
      assert.equal(closing.isError, false, text(closing));
      const closed = await wait("attachment closed", async () => { const r = await recordOf(record.attachmentId); return r.status === "closed" && r; });
      const presence = await presenceOf(record.attachmentId);
      assert.equal(closed.costComplete, true); assert.equal(closed.usageOffset, presence.shutdown.bytes, "Window does not end at the attached process's own shutdown size");
      const { task: resumed, receipt } = await resumeFollowup(session, launch, original);
      const old = await taskFor(session, launch.assignmentId);
      assert.equal(old.estimatedCost, task.estimatedCost); assert.equal(old.usageOffset, task.usageOffset, "Old task window moved");
      assert.ok(old.usageOffset <= closed.usageStartOffset && closed.usageOffset <= resumed.usageStartOffset, "Usage windows overlap");
      assert.ok(old.estimatedCost > 0 && closed.estimatedCost > 0 && resumed.estimatedCost > 0, "Each window must charge nonzero faux cost");
      assert.equal(closed.estimatedCost, await windowCost(original.sessionPath, closed.usageStartOffset, closed.usageOffset));
      assert.equal(resumed.estimatedCost, await windowCost(original.sessionPath, resumed.usageStartOffset, (await stat(receipt.sessionPath)).size));
      const whole = usageCost(await entries(original.sessionPath));
      assert.equal(old.estimatedCost + closed.estimatedCost + resumed.estimatedCost, whole, "Windows do not partition the saved session's actual cost");
      const snapshot = await wait("manifest includes closed attachment", async () => { const m = await manifest(session); return m.attachments?.some(a => a.attachmentId === record.attachmentId && a.status === "closed") && m; });
      const sum = snapshot.primaryCost + snapshot.tasks.reduce((n, t) => n + (t.estimatedCost ?? 0), 0) + snapshot.attachments.reduce((n, a) => n + (a.estimatedCost ?? 0), 0);
      assert.equal(snapshot.sessionTotal, sum, "Session total is not exactly primary + tasks + attachments");
      assert.equal(snapshot.sessionTotal, snapshot.primaryCost + whole, "Session total double counts or omits the saved worker session");
      assert.deepEqual(await artifactHashes(launch.assignmentId), artifacts, "Original result artifacts changed");
      console.log(`Usage windows: ${JSON.stringify({ old: [old.usageStartOffset, old.usageOffset, old.estimatedCost], attachment: [closed.usageStartOffset, closed.usageOffset, closed.estimatedCost], resumed: [resumed.usageStartOffset, resumed.usageOffset, resumed.estimatedCost], whole, total: snapshot.sessionTotal, primary: snapshot.primaryCost })}`);
    });

    await check("human /model and /thinking in an attachment persist to later open and continuation; old task profile not restored", async () => {
      const { session, launch, original, task } = await finishedNative();
      const { record, identity } = await openAttachment(session, launch, original);
      assert.equal(identity.model, "smoke-routing/worker");
      await herdr(["agent", "prompt", record.agentName, "/model smoke-routing/worker-alt"], env);
      await wait("saved model change", async () => (await entries(original.sessionPath)).some(e => e.type === "model_change" && e.modelId === "worker-alt"));
      await herdr(["agent", "prompt", record.agentName, "/thinking high"], env);
      await wait("saved thinking change", async () => (await entries(original.sessionPath)).some(e => e.type === "thinking_level_change" && e.thinkingLevel === "high"));
      await manualTurn(record.agentName, original.sessionPath);
      assert.ok((await entries(join(root, "trace.jsonl"))).some(e => e.event === "provider" && e.pid === record.workerPid && e.model === "worker-alt" && e.reasoning === "high"), "Manual turn did not use the human-selected model/thinking");
      assert.equal((await control(session, { action: "close", handle: launch.handle })).isError, false);
      await wait("first attachment closed", async () => (await recordOf(record.attachmentId)).status === "closed");
      const second = await openAttachment(session, launch, original);
      assert.deepEqual(second.record.model, { provider: "smoke-routing", modelId: "worker-alt" }); assert.equal(second.record.thinking, "high");
      assert.equal(second.identity.model, "smoke-routing/worker-alt"); assert.equal(second.identity.thinking, "high");
      assert.equal((await control(session, { action: "close", handle: launch.handle })).isError, false);
      await wait("second attachment closed", async () => (await recordOf(second.record.attachmentId)).status === "closed");
      const { next, task: resumed } = await resumeFollowup(session, launch, original);
      assert.equal(resumed.model, "smoke-routing/worker-alt"); assert.equal(resumed.thinking, "high");
      const worker = (await identities()).find(e => e.env.PI_ROUTED_ASSIGNMENT_ID === next.assignmentId);
      assert.equal(worker?.model, "smoke-routing/worker-alt"); assert.equal(worker?.thinking, "high");
      assert.ok((await traceFor(next.assignmentId)).some(e => e.event === "provider" && e.model === "worker-alt" && e.reasoning === "high"), "Continuation called a different model/thinking");
      const old = await taskFor(session, launch.assignmentId);
      assert.equal(old.model, task.model); assert.equal(old.thinking, task.thinking);
      console.log(`Saved policy: original ${task.model}/${task.thinking}; attachment+continuation ${resumed.model}/${resumed.thinking}`);
    });

    await check("more than four concurrent held tasks with disjoint scope; four panes per routed tab", async () => {
      const count = 6;
      const session = await start(`P3_SMOKE_FANOUT ${count} ${randomUUID().slice(0, 8)}`);
      const history = await finish(session, `P3_SMOKE_FANOUT_READY ${count}`);
      const launches = history.filter(e => e.message?.role === "toolResult" && e.message.toolName === "subagent").map(e => e.message);
      assert.equal(launches.length, count); assert.ok(launches.every(l => !l.isError), launches.map(text).join("\n"));
      const ids = launches.map(l => l.details.assignmentId);
      await wait("all workers concurrently held", async () => { const t = await entries(join(root, "trace.jsonl")); return ids.every(id => t.some(e => e.assignment === id && e.event === "hold_enter")); });
      for (const id of ids) assert.equal((await receiptFor(id)).outcome, "running");
      assert.equal((await manifest(session)).tasks.filter(t => ids.includes(t.assignmentId) && t.state === "running").length, count);
      const byTab = new Map(); for (const l of launches) byTab.set(l.details.tabId, (byTab.get(l.details.tabId) ?? 0) + 1);
      const live = await panes();
      for (const [tab] of byTab) assert.ok(live.filter(p => p.tab_id === tab).length <= 4, `Routed tab ${tab} exceeds four panes`);
      assert.ok(byTab.size >= 2, "Overflow did not create a second routed tab");
      assert.ok(!byTab.has(session.tab), "Workers split into the Root tab");
      console.log(`Fan-out: ${count} held tasks across ${byTab.size} tabs (${[...byTab.values()].join("+")})`);
      for (const id of ids) await writeFile(join(root, `release-${id}`), "release owned fan-out");
      for (const id of ids) await completed(session, id);
    });

    await check("all real Pi descendants are network denied; proxy errors absent", async () => {
      const trace = await entries(join(root, "trace.jsonl"));
      const pids = new Set(trace.filter(e => e.event === "agent_start").map(e => e.pid));
      assert.ok(pids.size > 10);
      for (const pid of pids) assert.ok(trace.some(e => e.pid === pid && e.event === "network_denied"), `Pi ${pid} lacks OS network denial proof`);
      assert.deepEqual(proxyErrors, []);
      console.log(`Observed ${pids.size} real Pi processes with OS-denied TCP probes`);
    });
    complete = true;
  } finally {
    // Never silently convert failed cleanup into a pass or erase a still-running runtime's state.
    if (nestedStarted) await run("herdr", ["session", "stop", name], env);
    for (const socket of connections) socket.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (hostTab) await herdr(["tab", "close", hostTab], process.env);
    if (complete && !failures.length) await rm(root, { recursive: true, force: true });
    else console.error(`Retained failed evidence: ${root}`);
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log(`PASS: ${passed} isolated real Pi/Herdr cases and exact owned teardown.`);
}

if (process.argv[2] === "--nested-host") {
  const [, , , name, root] = process.argv;
  // The external host Herdr launches this tab outside the caller sandbox lineage.
  // Apply network denial here, before creating the private runtime and all its panes.
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", networkSandbox, "herdr", "--session", name], { env: { ...environment(root, name), P3_SMOKE_SANDBOX: "1" }, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/smoke-routing.mjs (no remote model credentials required)");
  if (process.platform === "darwin" && process.env.P3_SMOKE_SANDBOX !== "1") {
    const child = spawnSync("/usr/bin/sandbox-exec", ["-p", networkSandbox, process.execPath, fileURLToPath(import.meta.url)], { env: { ...process.env, P3_SMOKE_SANDBOX: "1" }, stdio: "inherit" });
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  }
  await main();
}
