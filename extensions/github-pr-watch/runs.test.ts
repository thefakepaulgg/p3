import { describe, expect, test } from "bun:test";
import githubPullRequestWatchExtension from "../github-pr-watch.ts";
import { describeRunChanges, formatDuration, queueRunRoutine, snapshotOfRun, type RunData } from "./runs.ts";

const REPO = "example/desktop";
const URL = "https://github.com/example/desktop/actions/runs/7";

const job = (id: number, name: string, status = "in_progress", conclusion: string | null = null, failedStep?: string) => ({
  id, name, status, conclusion, html_url: `${URL}/job/${id}`,
  steps: failedStep ? [{ name: "Checkout", status: "completed", conclusion: "success" }, { name: failedStep, status: "completed", conclusion: "failure" }] : [],
});
const run = (overrides: Partial<RunData["run"]> = {}): RunData["run"] => ({
  id: 7, name: "Release", html_url: URL, status: "in_progress", conclusion: null, run_attempt: 1,
  head_branch: "v1.0.0-rc.1", created_at: "2026-01-01T10:00:00Z", run_started_at: "2026-01-01T10:00:00Z", updated_at: "2026-01-01T10:05:00Z", ...overrides,
});
const data = (overrides: Partial<RunData> = {}): RunData => ({ run: run(), jobs: [job(1, "Build")], waiting: [], ...overrides });

/** Serves `gh api <path>` from a mutable table and records every call. */
function fakeGh(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const exec = async (_command: string, args: string[]) => {
    const path = args[1]!;
    calls.push(path);
    if (!(path in routes)) return { code: 1, stdout: "", stderr: `HTTP 404: ${path}` };
    return { code: 0, stdout: JSON.stringify(routes[path]), stderr: "" };
  };
  return { exec, calls };
}

function harness(routes: Record<string, unknown>) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: any[] = [];
  const messages: Array<{ message: any; options: any }> = [];
  const gh = fakeGh(routes);
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {},
    on: (event: string, handler: any) => handlers.set(event, handler),
    events: { on: () => () => {}, emit: () => {} },
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    exec: gh.exec,
  };
  githubPullRequestWatchExtension(pi);
  const ctx: any = { hasUI: false, isIdle: () => false, hasPendingMessages: () => false, sessionManager: { getBranch: () => entries } };
  const poll = () => handlers.get("session_tree")!({}, ctx);
  return { tools, entries, messages, poll, calls: gh.calls };
}

const base = `repos/${REPO}/actions/runs/7`;
const jobsPath = `${base}/jobs?filter=latest&per_page=100`;

describe("workflow run changes", () => {
  test("detects a deployment approval wait once", () => {
    const previous = snapshotOfRun(data());
    const waiting = data({ run: run({ status: "waiting" }), waiting: ["production"] });
    expect(describeRunChanges(previous, waiting, false).wake).toEqual([
      `Waiting for deployment approval: "production". A human must approve it at ${URL}`,
    ]);
    expect(describeRunChanges(snapshotOfRun(waiting), waiting, false)).toEqual({ wake: [], routine: [] });
  });

  test("reports a failed job with its failing step and batches successes", () => {
    const previous = snapshotOfRun(data({ jobs: [job(1, "Build (Linux)"), job(2, "Build (macOS)")] }));
    const changes = describeRunChanges(previous, data({ jobs: [
      job(1, "Build (Linux)", "completed", "success"), job(2, "Build (macOS)", "completed", "failure", "Notarize"),
    ] }), false);
    expect(changes.wake).toEqual([`Job "Build (macOS)" failure at step "Notarize"\n${URL}/job/2`]);
    expect(changes.routine).toEqual(['job "Build (Linux)" succeeded']);
  });

  test("reports completion with conclusion, duration, failed jobs and release", () => {
    const previous = snapshotOfRun(data());
    const done = data({
      run: run({ status: "completed", conclusion: "failure" }),
      jobs: [job(1, "Build", "completed", "failure", "Package")],
      release: { tag_name: "v1.0.0-rc.1", name: "App 1.0.0-rc.1", draft: true, prerelease: true, assets: [{}, {}], html_url: "https://rel" },
    });
    const changes = describeRunChanges(previous, done, true);
    expect(changes.wake).toEqual([[
      "Run completed: failure in 5m 0s (attempt 1)",
      `Job "Build" failure at step "Package"\n${URL}/job/1`,
      'Release "App 1.0.0-rc.1" (draft, prerelease, 2 assets)\nhttps://rel',
    ].join("\n")]);
    expect(changes.routine).toEqual(['release created: "App 1.0.0-rc.1" (draft, prerelease, 2 assets)\nhttps://rel']);
    expect(describeRunChanges(previous, done, false).wake[0]).not.toContain("Release");
    const published = describeRunChanges(snapshotOfRun(done), { ...done, release: { ...done.release!, draft: false } }, true);
    expect(published.routine[0]).toStartWith('release published: "App 1.0.0-rc.1" (published, prerelease, 2 assets)');
  });

  test("notices a re-run attempt and its new jobs", () => {
    const previous = snapshotOfRun(data({ jobs: [job(1, "Build", "in_progress")] }));
    const rerun = data({ run: run({ run_attempt: 2, status: "queued" }), jobs: [job(9, "Build", "queued")] });
    expect(describeRunChanges(previous, rerun, false).wake).toEqual(["Attempt 1 ended and re-run attempt 2 started"]);
    expect(snapshotOfRun(rerun).jobs).toEqual({ 9: "queued/" });
  });

  test("routine events accumulate in one line per run", () => {
    const first = queueRunRoutine(["other: x"], "k", ["job \"A\" succeeded"]);
    expect(queueRunRoutine(first, "k", ["job \"B\" succeeded"])).toEqual(["other: x", 'k: job "A" succeeded; job "B" succeeded']);
    expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
  });
});

describe("run subscriptions", () => {
  test("resolves by tag and workflow to the newest run, then wakes on approval and completion", async () => {
    const routes: Record<string, unknown> = {
      [`repos/${REPO}/actions/workflows/release.yml/runs?branch=v1.0.0-rc.1&per_page=1`]: { workflow_runs: [run()] },
      [base]: run(),
      [jobsPath]: { jobs: [job(1, "Build")] },
    };
    const { tools, entries, messages, poll, calls } = harness(routes);
    const subscribed = await tools.get("run_subscribe").execute("1", { repository: REPO, ref: "v1.0.0-rc.1", workflow: "release.yml" });
    expect(subscribed.details).toEqual({ repository: REPO, runId: 7, subscribed: true });
    expect(calls[0]).toBe(`repos/${REPO}/actions/workflows/release.yml/runs?branch=v1.0.0-rc.1&per_page=1`);

    routes[base] = run({ status: "waiting" });
    routes[jobsPath] = { jobs: [job(1, "Build", "completed", "success"), job(2, "Publish", "waiting")] };
    routes[`${base}/pending_deployments`] = [{ environment: { name: "release" } }];
    await poll();
    await poll();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.options.deliverAs).toBe("steer");
    expect(messages[0]!.message.content).toContain('- job "Build" succeeded\n- Waiting for deployment approval: "release". A human must approve it at');
    expect(messages[0]!.message.content).toContain("untrusted data");

    routes[base] = run({ status: "completed", conclusion: "success", updated_at: "2026-01-01T10:12:30Z" });
    routes[`${base}/approvals`] = [];
    routes[jobsPath] = { jobs: [job(1, "Build", "completed", "success"), job(2, "Publish", "completed", "success")] };
    await poll();
    expect(messages).toHaveLength(2);
    expect(messages[1]!.message.content).toContain('- job "Publish" succeeded\n- Approved: "release"\n- Run completed: success in 12m 30s (attempt 1)');
    expect(entries.at(-1).data.runs).toEqual([]);
    const listed = await tools.get("pr_subscriptions").execute("2", {});
    expect(listed.details.runs).toEqual([]);
  });

  test("holds routine job progress until flushed, then unsubscribes", async () => {
    const routes: Record<string, unknown> = { [base]: run(), [jobsPath]: { jobs: [job(1, "Build"), job(2, "Test")] } };
    const { tools, messages, poll } = harness(routes);
    await tools.get("run_subscribe").execute("1", { repository: REPO, run_id: 7 });
    routes[jobsPath] = { jobs: [job(1, "Build", "completed", "success"), job(2, "Test")] };
    await poll();
    expect(messages).toHaveLength(0);
    expect((await tools.get("pr_flush").execute("2", {})).content[0].text).toContain(`${REPO} run 7: job "Build" succeeded`);
    expect((await tools.get("run_unsubscribe").execute("3", { repository: REPO, run_id: 7 })).content[0].text).toBe(`Unsubscribed from ${REPO} run 7`);
  });

  test("follows a re-run of a completed run and does not subscribe to a finished one", async () => {
    const routes: Record<string, unknown> = {
      [base]: run({ status: "completed", conclusion: "failure" }),
      [jobsPath]: { jobs: [job(1, "Build", "completed", "failure", "Compile")] },
    };
    const { tools } = harness(routes);
    const finished = await tools.get("run_subscribe").execute("1", { repository: REPO, run_id: 7 });
    expect(finished.details.subscribed).toBe(false);
    expect(finished.content[0].text).toContain('Run completed: failure in 5m 0s (attempt 1)\nJob "Build" failure at step "Compile"');

    routes[base] = run({ status: "queued", run_attempt: 2 });
    routes[jobsPath] = { jobs: [job(5, "Build", "queued")] };
    const rerun = await tools.get("run_subscribe").execute("2", { repository: REPO, run_id: 7 });
    expect(rerun.details.subscribed).toBe(true);
    expect(rerun.content[0].text).toContain("Status queued, attempt 2; 0/1 jobs finished");
  });

  test("waits for a run that appears after subscribing, then times out when none does", async () => {
    const resolvePath = `repos/${REPO}/actions/workflows/release.yml/runs?branch=v1.0.0-rc.1&per_page=1`;
    const routes: Record<string, unknown> = { [resolvePath]: { workflow_runs: [] } };
    const { tools, messages, poll } = harness(routes);
    const params = { repository: REPO, ref: "v1.0.0-rc.1", workflow: "release.yml" };
    const subscribed = await tools.get("run_subscribe").execute("1", params);
    expect(subscribed.details.subscribed).toBe(true);
    expect(subscribed.content[0].text).toContain("waiting up to 30 minutes");

    routes[resolvePath] = { workflow_runs: [run({ created_at: "2000-01-01T00:00:00Z" })] };
    await poll();
    expect((await tools.get("pr_subscriptions").execute("2", {})).content[0].text).toContain("waiting for the run to appear");

    const now = new Date().toISOString();
    routes[resolvePath] = { workflow_runs: [run({ created_at: now })] };
    routes[base] = run({ status: "waiting", created_at: now });
    routes[jobsPath] = { jobs: [job(1, "Publish", "waiting")] };
    routes[`${base}/pending_deployments`] = [{ environment: { name: "release" } }];
    await poll();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.content).toContain(`${REPO} run 7 — "Release"\n${URL}\n- run started\n- Waiting for deployment approval: "release"`);
    expect((await tools.get("pr_subscriptions").execute("3", {})).details.runs).toEqual([{ repository: REPO, runId: 7 }]);

    const late = harness({ [resolvePath]: { workflow_runs: [] } });
    await late.tools.get("run_subscribe").execute("1", params);
    late.entries.at(-1).data.runs[0].subscribedAt -= 31 * 60_000;
    await late.poll();
    expect(late.messages[0]!.message.content).toContain('No "release.yml" run appeared for "v1.0.0-rc.1" within 30 minutes; unsubscribed.');
    expect(late.entries.at(-1).data.runs).toEqual([]);
  });

  describe("deployment reviews", () => {
    const approvalsPath = `${base}/approvals`;
    const pendingPath = `${base}/pending_deployments`;
    async function waitingRun(environments = ["release"]) {
      const routes: Record<string, unknown> = {
        [base]: run({ status: "waiting" }), [jobsPath]: { jobs: [job(1, "Publish", "waiting")] },
        [pendingPath]: environments.map((name) => ({ environment: { name } })),
      };
      const watched = harness(routes);
      await watched.tools.get("run_subscribe").execute("1", { repository: REPO, run_id: 7 });
      return { ...watched, routes };
    }
    const review = (state: string, login: string, ...environments: string[]) =>
      ({ state, user: { login }, comment: "", environments: environments.map((name) => ({ name })) });

    test("waited, then approved, reported once with the reviewer", async () => {
      const { routes, messages, poll, calls } = await waitingRun();
      await poll(); await poll();
      expect(messages).toHaveLength(0);
      expect(calls).not.toContain(approvalsPath);
      routes[base] = run();
      routes[jobsPath] = { jobs: [job(1, "Publish", "in_progress")] };
      routes[approvalsPath] = [review("approved", "paul", "release", "release")];
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.options.deliverAs).toBe("steer");
      expect(messages[0]!.message.content).toContain('- Approved: "release" (by @paul); the run continues');
      await poll();
      expect(messages).toHaveLength(1);
    });

    test("waited, then rejected", async () => {
      const { routes, messages, poll } = await waitingRun();
      routes[base] = run({ status: "completed", conclusion: "failure" });
      routes[jobsPath] = { jobs: [job(1, "Publish", "completed", "failure")] };
      routes[approvalsPath] = [review("rejected", "paul", "release")];
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.message.content).toContain('- Rejected: "release" by @paul; run cancelled\n- Run completed: failure');
    });

    test("waited, then approved while the approvals endpoint is still empty", async () => {
      const { routes, messages, poll } = await waitingRun();
      routes[base] = run();
      routes[jobsPath] = { jobs: [job(1, "Publish", "in_progress")] };
      routes[approvalsPath] = [];
      await poll();
      expect(messages[0]!.message.content).toContain('- Approved: "release"; the run continues');
    });

    test("several environments are each reported once as their waits clear", async () => {
      const { routes, messages, poll } = await waitingRun(["release", "store"]);
      routes[pendingPath] = [{ environment: { name: "store" } }];
      routes[approvalsPath] = [review("approved", "paul", "release")];
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.message.content).toContain('- Approved: "release" (by @paul)');
      await poll();
      expect(messages).toHaveLength(1);
      routes[base] = run();
      routes[approvalsPath] = [review("approved", "ana", "store"), review("approved", "paul", "release")];
      await poll();
      expect(messages).toHaveLength(2);
      expect(messages[1]!.message.content).toContain('- Approved: "store" (by @ana); the run continues');
      expect(messages[1]!.message.content).not.toContain('"release" (by');
    });
  });

  test("requires a run ID or a ref with a workflow", async () => {
    const { tools } = harness({});
    expect((await tools.get("run_subscribe").execute("1", { repository: REPO, ref: "v1" })).isError).toBe(true);
  });
});
