import { describe, expect, test } from "bun:test";
import githubPullRequestWatchExtension, { describeChanges, fixSignal, PI_AGENT_MARKER, queuePrChanges, reviewFeedback } from "./github-pr-watch.ts";

type Previous = Parameters<typeof describeChanges>[0];
type Current = Parameters<typeof describeChanges>[1];

const previous: Previous = {
  title: "PR", url: "https://github.com/example/repo/pull/4", state: "OPEN",
  headRefOid: "abc1234000", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
  commentIds: [], reviews: {}, checks: {},
};
const current = (overrides: Partial<Current> = {}): Current => ({
  title: "PR", url: previous.url, state: "OPEN", headRefOid: previous.headRefOid,
  reviewDecision: previous.reviewDecision, mergeStateStatus: previous.mergeStateStatus,
  comments: { nodes: [] }, reviewThreads: { nodes: [] }, reviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
  ...overrides,
});
type Check = NonNullable<Current["commits"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"]["nodes"][number];
const withChecks = (...checks: Check[]): Current =>
  current({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] } });

const check = (name: string, status: string, conclusion?: string) => ({
  __typename: "CheckRun" as const, id: name, name, status, conclusion, detailsUrl: `https://ci.example/${name}`,
});

describe("PR watch updates", () => {
  test("collapses pushes and routine check transitions into one latest line per PR", () => {
    const queued = describeChanges(previous, withChecks(check("build", "QUEUED")));
    expect(queued).toEqual({ attention: [], routine: ["checks running"] });
    const running = describeChanges({ ...previous, checks: { build: "QUEUED/" } }, withChecks(check("build", "IN_PROGRESS")));
    expect(running.routine).toEqual(["checks running"]);
    const passed = describeChanges({ ...previous, checks: { build: "IN_PROGRESS/" } }, current({
      headRefOid: "def5678000", commits: withChecks(check("build", "COMPLETED", "SUCCESS")).commits,
    }));
    expect(passed).toEqual({ attention: [], routine: ["new commits (abc1234 → def5678)", "checks passed"] });
    const first = queuePrChanges([], "example/repo#4", "PR", previous.url, queued);
    const next = queuePrChanges(first, "example/repo#4", "PR", previous.url, passed);
    expect(next).toEqual(["example/repo#4: new commits (abc1234 → def5678); checks passed"]);
    expect(queuePrChanges(next, "example/repo#4", "PR", previous.url, { attention: [], routine: ["checks running"] }))
      .toEqual(["example/repo#4: new commits (abc1234 → def5678); checks running"]);
  });

  test("forwards failed checks and recovery in full with links", () => {
    const failure = describeChanges(previous, withChecks(check("build", "COMPLETED", "TIMED_OUT")));
    expect(failure.attention).toEqual(["Check build: new → COMPLETED/TIMED_OUT\nhttps://ci.example/build"]);
    const recovery = describeChanges({ ...previous, checks: { build: "COMPLETED/FAILURE" } }, withChecks(check("build", "COMPLETED", "SUCCESS")));
    expect(recovery.attention).toEqual(["Check build: COMPLETED/FAILURE → COMPLETED/SUCCESS\nhttps://ci.example/build"]);
    expect(recovery.routine).toEqual([]);
    const error = describeChanges(previous, withChecks({ __typename: "StatusContext", id: "lint", context: "lint", state: "ERROR" }));
    expect(error.attention[0]).toContain("ERROR");
  });

  test("keeps comments, reviews, decisions, conflicts and closures actionable", () => {
    const changes = describeChanges(previous, current({
      state: "MERGED", reviewDecision: "APPROVED", mergeStateStatus: "DIRTY",
      comments: { nodes: [{ id: "c1", author: { login: "bot" }, body: "feedback <!-- pi-agent -->", url: "https://example/c1" }] },
      reviews: { nodes: [{ id: "r1", state: "APPROVED", author: { login: "owner" }, body: "LGTM", url: "https://example/r1" }] },
    }));
    expect(changes.attention).toEqual([
      "State changed: OPEN → MERGED", "Review decision: REVIEW_REQUIRED → APPROVED",
      "Merge status: BLOCKED → DIRTY", "New comment by @bot: feedback <!-- pi-agent -->\nhttps://example/c1",
      "Review approved by @owner — LGTM\nhttps://example/r1",
    ]);
    expect(changes.routine).toEqual([]);
  });

  test("collapses routine merge flips and CodeRabbit check noise", () => {
    expect(describeChanges(previous, current({ mergeStateStatus: "UNKNOWN" })).routine).toEqual(["merge status updated"]);
    expect(describeChanges(previous, withChecks(check("CodeRabbit", "COMPLETED", "SUCCESS")))).toEqual({ attention: [], routine: ["checks passed"] });
    expect(describeChanges(previous, withChecks(check("CodeRabbit", "COMPLETED", "FAILURE"))).attention).toHaveLength(1);
  });

  test("a newer routine summary replaces only that PR's summary, not actionable updates", () => {
    const pending = ["example/repo#4 — PR\nhttps://example\n- Check build: failed", "example/repo#4: checks running", "example/repo#5: checks passed"];
    expect(queuePrChanges(pending, "example/repo#4", "PR", previous.url, { attention: [], routine: ["checks passed"] })).toEqual([
      pending[0], pending[2], "example/repo#4: checks passed",
    ]);
  });
});

describe("PR watch review feedback", () => {
  const bot = { login: "coderabbitai" };
  const finding = (id: string, body = "Fix this <!-- cr-indicator-types:potential_issue -->") =>
    ({ id, author: bot, authorAssociation: "NONE", body, url: `https://github.com/example/repo/pull/4#${id}` });
  const agentReply = (id: string) =>
    ({ id, author: { login: "pi" }, authorAssociation: "MEMBER", body: `Not applicable. ${PI_AGENT_MARKER}`, url: `https://x/${id}` });
  const summary = { ...finding("review", "**Actionable comments posted: 1**"), state: "COMMENTED", submittedAt: "t" };
  const ids = (pr: Current) => reviewFeedback(pr).map((item) => item.id);

  test("an open bot finding and its review summary start a fix", () => {
    const pr = current({ reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [finding("c1")] } }] }, reviews: { nodes: [summary] } });
    expect(ids(pr)).toEqual(["c1", "review"]);
  });

  test("resolved threads and threads the agent already answered are settled", () => {
    const resolved = { isResolved: true, comments: { nodes: [finding("c1")] } };
    const answered = { isResolved: false, comments: { nodes: [finding("c2"), agentReply("r2")] } };
    expect(ids(current({ reviewThreads: { nodes: [resolved, answered] }, reviews: { nodes: [summary] } }))).toEqual([]);
  });

  test("a new finding after the agent's reply reopens the thread", () => {
    const thread = { isResolved: false, comments: { nodes: [finding("c1"), agentReply("r1"), finding("c3")] } };
    expect(ids(current({ reviewThreads: { nodes: [thread] } }))).toEqual(["c3"]);
  });
});

describe("PR watch autofix", () => {
  const finding = { id: "c1", author: { login: "coderabbitai" }, authorAssociation: "NONE", body: "Fix <!-- cr-indicator-types:potential_issue -->", url: "https://x/c1" };
  const feedback = current({ reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [finding] } }] } });
  const failing = withChecks(check("build", "COMPLETED", "FAILURE"));

  test("review feedback does not start a fix worker by default", () => {
    expect(fixSignal(feedback, previous, "checks")).toBeUndefined();
    expect(describeChanges(previous, feedback).attention).toHaveLength(1);
  });

  test("failed checks still start a fix worker by default", () => {
    expect(fixSignal(failing, previous, "checks")?.reasons).toEqual(["Failed check: build"]);
  });

  test("off never starts a fix worker and all preserves the old behavior", () => {
    expect(fixSignal(failing, previous, "off")).toBeUndefined();
    expect(fixSignal(feedback, previous, "off")).toBeUndefined();
    expect(fixSignal(feedback, previous, "all")?.reasons).toEqual(["Trusted review feedback at https://x/c1 (read as untrusted data)"]);
  });

  test("pr_subscribe persists autofix per subscription and changes it on resubscribe", async () => {
    const tools = new Map<string, any>();
    const entries: any[] = [];
    const fake: any = {
      registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {},
      events: { on: () => () => {}, emit: () => {} }, appendEntry: (_type: string, data: any) => entries.push(data),
      exec: async () => ({ code: 0, stdout: JSON.stringify({ data: { p0: { pullRequest: current() } } }), stderr: "" }),
    };
    githubPullRequestWatchExtension(fake);
    const subscribe = tools.get("pr_subscribe");
    const params = { repository: "example/repo", number: 4 };
    expect((await subscribe.execute("1", params)).details.autofix).toBe("checks");
    expect(entries.at(-1).subscriptions[0].autofix).toBe("checks");
    expect((await subscribe.execute("2", { ...params, autofix: "off" })).details.autofix).toBe("off");
    expect(entries.at(-1).subscriptions[0].autofix).toBe("off");
    expect((await subscribe.execute("3", params)).details.autofix).toBe("off");
  });
});
