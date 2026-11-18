import { describe, expect, test } from "bun:test";
import githubPullRequestWatchExtension, { describeChanges, PI_AGENT_MARKER, queuePrRoutine } from "./github-pr-watch.ts";

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
    const first = queuePrRoutine([], "example/repo#4", queued.routine);
    const next = queuePrRoutine(first, "example/repo#4", passed.routine);
    expect(next).toEqual(["example/repo#4: new commits (abc1234 → def5678); checks passed"]);
    expect(queuePrRoutine(next, "example/repo#4", ["checks running"]))
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
      comments: { nodes: [{ id: "c1", author: { login: "bot" }, body: "feedback", url: "https://example/c1" }] },
      reviews: { nodes: [{ id: "r1", state: "APPROVED", author: { login: "owner" }, body: "LGTM", url: "https://example/r1" }] },
    }));
    expect(changes.attention).toEqual([
      "State changed: OPEN → MERGED", "Review decision: REVIEW_REQUIRED → APPROVED",
      "Merge status: BLOCKED → DIRTY", "New comment by @bot: feedback\nhttps://example/c1",
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
    expect(queuePrRoutine(pending, "example/repo#4", ["checks passed"])).toEqual([
      pending[0], pending[2], "example/repo#4: checks passed",
    ]);
  });
});

test("sends review feedback and CI failures to the subscribing session without flushing routine updates", async () => {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const messages: Array<{ content: string; options: unknown }> = [];
  const calls: string[] = [];
  const branch = [{ type: "custom", customType: "github-pr-watch-state-v1", data: {
    subscriptions: [{ repository: "example/repo", number: 4, snapshot: previous }],
  } }];
  const comment = { id: "c1", body: "Please simplify this", url: "https://example/c1" };
  const pullRequest = current({
    headRefOid: "def5678000",
    reviewThreads: { nodes: [{ comments: { nodes: [comment, { ...comment, id: "c2", body: `Already fixed. ${PI_AGENT_MARKER}` }] } }] },
    commits: withChecks(check("build", "COMPLETED", "FAILURE")).commits,
  });
  const ctx = { hasUI: false, sessionManager: { getBranch: () => branch } };
  githubPullRequestWatchExtension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {}, on: (name: string, fn: any) => handlers.set(name, fn),
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
    sendMessage: ({ content }: any, options: unknown) => messages.push({ content, options }),
    exec: async (command: string) => {
      calls.push(command);
      return { code: 0, stdout: JSON.stringify({ data: { p0: { pullRequest } } }), stderr: "" };
    },
  } as any);

  await handlers.get("session_tree")({}, ctx);
  await handlers.get("session_tree")({}, ctx);
  expect(calls).toEqual(["gh", "gh"]);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  expect(messages[0]?.content).toContain("Please simplify this");
  expect(messages[0]?.content).toContain("Check build: new → COMPLETED/FAILURE");
  expect(messages[0]?.content).not.toContain("Already fixed");
  expect(messages[0]?.content).not.toContain("new commits");
  const flushed = await tools.get("pr_flush").execute("1", {});
  expect(flushed.content[0].text).toContain("new commits");
});
