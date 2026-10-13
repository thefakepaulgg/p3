#!/usr/bin/env node
// Opt-in real Pi/Herdr process-boundary checks; only model decisions are simulated.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const quote = (args) => args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
const secret = (key) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key);
const inherited = (key) => key.startsWith("HERDR_") && key !== "HERDR_ENV" || /^PI_ROUT(ED|ING)_|^PI_SUBAGENT_/.test(key);
function environment(root, session) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !secret(key) && !inherited(key)));
  Object.assign(env, { XDG_CONFIG_HOME: join(root, "c"), XDG_STATE_HOME: join(root, "s"), HERDR_CONFIG_PATH: join(root, "herdr.toml"), PI_CODING_AGENT_DIR: join(root, "a"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), TMPDIR: join(root, "tmp"), PI_OFFLINE: "1" });
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
  let hostTab;
  let nestedStarted = false;
  const tabs = new Set();
  try {
    await Promise.all([cwd, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_SESSION_DIR, env.TMPDIR].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    await copyFile(join(repo, "package.json"), join(cwd, "package.json"));
    await run("git", ["init", "--quiet", cwd], env);
    await writeFile(env.HERDR_CONFIG_PATH, "[experimental]\nallow_nested = true\n", { mode: 0o600 });
    await writeFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
      defaultProvider: "smoke-routing", defaultModel: "root", retry: { enabled: false, maxRetries: 0 },
      extensions: [join(repo, "extensions", "model-routing.ts"), join(repo, "scripts", "smoke-routing-provider.ts")],
    }), { mode: 0o600 });
    await run("herdr", ["integration", "install", "pi"], env);
    const clear = Object.keys(process.env).filter((key) => secret(key) || /^PI_ROUT(ED|ING)_|^PI_SUBAGENT_/.test(key)).flatMap((key) => ["--env", `${key}=`]);
    const overrides = ["HERDR_CONFIG_PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "TMPDIR", "PI_OFFLINE"].flatMap((key) => ["--env", `${key}=${env[key]}`]);
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
    const start = async (prompt, savedSession) => {
      const created = await herdr(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", "p3 smoke", "--no-focus"], env);
      const tab = created.tab.tab_id;
      tabs.add(tab);
      const agentName = `smoke-${randomUUID().slice(0, 8)}`;
      await herdr(["agent", "start", agentName, "--kind", "pi", "--pane", created.root_pane.pane_id, "--timeout", "30000", "--", "--approve", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", "smoke-routing/root", ...(savedSession ? ["--session", savedSession] : [])], env);
      await herdr(["agent", "prompt", agentName, prompt, "--wait", "--until", "working", "--until", "done", "--timeout", "10000"], env);
      const info = await herdr(["agent", "get", agentName], env);
      assert.ok(info.agent.agent_session?.value, "Real root session was not published");
      return { tab, path: info.agent.agent_session.value };
    };
    const finish = async (session, marker) => wait(marker, async () => {
      const history = await entries(session.path);
      return history.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop" && text(entry.message).startsWith(marker)) ? history : undefined;
    });

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
      const task = current.filter((entry) => entry.type === "custom" && entry.customType === "routed-task" && entry.data?.assignmentId === id).at(-1)?.data;
      return task?.completionNotifiedAt && task.paneClosedAt && !task.pendingCompletion ? current : undefined;
    });
    assert.equal(correlatedResult(history, "subagent_control", (args) => args.action === "result")?.details?.durable, true);
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
    console.log("PASS: real delegated read, rejected write, correlated outcomes, artifact integrity, delivered receipt, pane cleanup, primary restart, and terminal failure.");
  } finally {
    // Never silently convert failed cleanup into a pass or erase a still-running runtime's state.
    if (nestedStarted) await run("herdr", ["session", "stop", name], env);
    if (hostTab) await herdr(["tab", "close", hostTab], process.env);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--nested-host") {
  const [, , , name, root] = process.argv;
  const result = spawnSync("herdr", ["--session", name], { env: environment(root, name), stdio: "inherit" });
  process.exit(result.status ?? 1);
} else {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/smoke-routing.mjs (no remote model credentials required)");
  await main();
}
