import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBranchWork, writeBranchWork, type BranchWork } from "./branch-work.ts";
import { setMuxForTests, type Mux } from "./mux.ts";
import { markBranchWorkMerged, removeMergedWorktrees } from "./worktree-cleanup.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let temp: string;
let main: string;
let worktree: string;
let children: ChildProcess[];
let agents: any[] | undefined;

const run = (cwd: string, command: string, ...args: string[]) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const git = (cwd: string, ...args: string[]) => run(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args);

const fakePi: any = {
  exec: async (command: string, args: string[], options: { cwd?: string } = {}) => {
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
};

const record = (patch: Partial<BranchWork> = {}): BranchWork => ({
  version: 1, id: "work-1", repo: join(main, ".git"), branch: "feature", objective: "task", description: "task", worktree,
  executor: { agent: "i-1", pane: "t2", terminal: "t2", workspace: "w1", sessionId: "s1", sessionPath: join(temp, "s1.jsonl") },
  status: "merged", createdAt: 1, updatedAt: 1, ...patch,
});

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "worktree-cleanup-")));
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  children = [];
  agents = [];
  setMuxForTests({ backend: "core", listAgents: async () => agents } as unknown as Mux);
  const origin = join(temp, "origin.git");
  main = join(temp, "main");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  git(temp, "clone", origin, main);
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", ".");
  git(main, "commit", "-m", "init");
  git(main, "push", "-u", "origin", "main");
  worktree = join(temp, "wt");
  git(main, "worktree", "add", "-b", "feature", worktree);
  writeFileSync(join(worktree, "b.txt"), "b");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "feature");
  git(worktree, "push", "-u", "origin", "feature");
  git(main, "merge", "--no-ff", "feature", "-m", "merge");
  writeBranchWork(record());
});

afterEach(() => {
  for (const child of children) child.kill();
  setMuxForTests();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(temp, { recursive: true, force: true });
});

const kept = async () => {
  await removeMergedWorktrees(fakePi);
  expect(existsSync(worktree)).toBe(true);
  expect(readBranchWork(join(main, ".git"), "feature")!.status).toBe("merged");
};

describe("removing merged worktrees", () => {
  test("removes a clean, pushed, unoccupied worktree, deletes its branch and marks the record", async () => {
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(false);
    expect(git(main, "branch", "--list", "feature")).toBe("");
    expect(readBranchWork(join(main, ".git"), "feature")!.status).toBe("removed");
  });

  test("a merged head that does not match still passes through the all-pushed-to-remote test, keeping -d", async () => {
    writeBranchWork(record({ mergedHeadOid: git(main, "rev-parse", "origin/main") }));
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(false);
    expect(git(main, "branch", "--list", "feature")).toBe("");
  });

  test("only merged records are touched", async () => {
    writeBranchWork(record({ status: "open" }));
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(true);
  });

  test("keeps uncommitted changes, including untracked files", async () => {
    writeFileSync(join(worktree, "untracked.txt"), "x");
    await kept();
  });

  test("keeps unpushed commits", async () => {
    writeFileSync(join(worktree, "c.txt"), "c");
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "local only");
    await kept();
  });

  test("keeps a worktree with another worktree nested inside it", async () => {
    git(main, "worktree", "add", "-b", "nested", join(worktree, "nested"));
    await kept();
  });

  test("keeps a worktree while a process has its cwd inside, then removes it once gone", async () => {
    const child = spawn("sleep", ["30"], { cwd: worktree });
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    await Bun.sleep(100);
    await kept();
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(false);
  });

  test("keeps a worktree a Herdr agent reports in, and when agents cannot be listed", async () => {
    agents = [{ raw: { cwd: worktree } }];
    await kept();
    agents = undefined;
    await kept();
  });

  test("keeps a branch that git considers unmerged but still removes the clean worktree", async () => {
    git(main, "reset", "--hard", "HEAD^");
    git(main, "branch", "--unset-upstream", "feature");
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(false);
    expect(git(main, "branch", "--list", "feature")).toContain("feature");
  });
});

describe("squash-merged PRs whose remote branch was deleted", () => {
  let head: string;
  beforeEach(() => {
    head = git(worktree, "rev-parse", "HEAD");
    git(main, "reset", "--hard", "origin/main");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-m", "squash");
    git(main, "push", "origin", "main");
    git(main, "push", "origin", "--delete", "feature");
    git(main, "fetch", "--prune");
    expect(git(main, "branch", "-r")).not.toContain("origin/feature");
  });

  test("without the merged head SHA the commits look unpushed and the worktree stays", async () => {
    await kept();
  });

  test("HEAD equal to the merged PR head is proven pushed: worktree removed and branch force-deleted", async () => {
    writeBranchWork(record({ mergedHeadOid: head }));
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(false);
    expect(git(main, "branch", "--list", "feature")).toBe("");
    expect(readBranchWork(join(main, ".git"), "feature")!.status).toBe("removed");
  });

  test("HEAD that is an ancestor of the merged PR head is proven too", async () => {
    writeFileSync(join(worktree, "d.txt"), "d");
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "later commit in the PR");
    const prHead = git(worktree, "rev-parse", "HEAD");
    git(worktree, "reset", "--hard", "HEAD^");
    writeBranchWork(record({ mergedHeadOid: prHead }));
    await removeMergedWorktrees(fakePi);
    expect(existsSync(worktree)).toBe(false);
  });

  test("a commit made after the merged PR head is not proven and keeps the worktree and branch", async () => {
    writeFileSync(join(worktree, "e.txt"), "e");
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "after merge");
    writeBranchWork(record({ mergedHeadOid: head }));
    await kept();
    expect(git(main, "branch", "--list", "feature")).toContain("feature");
  });
});

describe("marking branch work merged", () => {
  test("matches the record by branch and the checkout's origin remote", async () => {
    writeBranchWork(record({ status: "open" }));
    const head = git(worktree, "rev-parse", "HEAD");
    git(main, "remote", "set-url", "origin", "git@github.com:Example/Repo.git");
    await markBranchWorkMerged(fakePi, "example/other", "feature", head);
    expect(readBranchWork(join(main, ".git"), "feature")!.status).toBe("open");
    await markBranchWorkMerged(fakePi, "example/repo", "other-branch", head);
    expect(readBranchWork(join(main, ".git"), "feature")!.status).toBe("open");
    await markBranchWorkMerged(fakePi, "example/repo", "feature", head);
    expect(readBranchWork(join(main, ".git"), "feature")).toMatchObject({ status: "merged", mergedHeadOid: head });
  });
});
