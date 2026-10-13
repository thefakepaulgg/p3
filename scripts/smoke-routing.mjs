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
    await run("herdr", ["integration", "install", "pi"], env);
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
