import { describe, expect, test } from "bun:test";
import { describeChanges, queuePrChanges } from "./github-pr-watch.ts";

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
