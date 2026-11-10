import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listBranchWork, readBranchWork, withBranchWorkLock, writeBranchWork, type BranchWork } from "./branch-work.ts";
import { mux } from "./mux.ts";

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);

const git = async (pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> => {
  const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};

/** Paths of the repository's registered worktrees; the first is the main checkout. */
const registeredWorktrees = async (pi: ExtensionAPI, cwd: string) =>
  (await git(pi, cwd, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => real(line.slice(9)));

/** A live process or Herdr agent with its cwd in the checkout. Unverifiable counts as occupied. */
async function occupied(pi: ExtensionAPI, path: string): Promise<boolean> {
  try {
    const agents = await mux().listAgents(pi);
    if (!agents || agents.some((agent) => typeof agent.raw?.cwd === "string" && within(path, real(agent.raw.cwd)))) return true;
    const lsof = await pi.exec("lsof", ["-a", "-d", "cwd", "-Fn"], { timeout: 30_000 });
    const cwds = lsof.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => real(line.slice(1)));
    return !cwds.length || cwds.some((cwd) => within(path, cwd));
  } catch { return true; }
}

/** HEAD is the merged PR's head commit or an ancestor of it: everything here was merged, even if squashed. */
async function mergedIntoPr(pi: ExtensionAPI, path: string, oid?: string): Promise<boolean> {
  if (!oid) return false;
  const result = await pi.exec("git", ["-C", path, "merge-base", "--is-ancestor", "HEAD", oid], { timeout: 30_000 });
  return result.code === 0;
}

/** Why the checkout must stay (or, when safe, whether the merged PR head proves it fully merged). */
async function blocker(pi: ExtensionAPI, work: BranchWork): Promise<{ reason?: string; proven?: boolean }> {
  const path = work.worktree;
  if (!existsSync(path)) return { reason: "checkout is missing" };
  if (await git(pi, path, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== work.branch) return { reason: "checkout is on another branch" };
  const [main, ...linked] = await registeredWorktrees(pi, path);
  if (main === path || !linked.includes(path)) return { reason: "not a linked worktree" };
  if (linked.some((other) => other !== path && within(path, other))) return { reason: "another worktree is nested inside it" };
  if (await git(pi, path, ["status", "--porcelain"])) return { reason: "uncommitted changes" };
  const proven = await mergedIntoPr(pi, path, work.mergedHeadOid);
  if (!proven && await git(pi, path, ["log", "HEAD", "--not", "--remotes", "--oneline"])) return { reason: "unpushed commits" };
  if (await git(pi, path, ["submodule", "foreach", "--quiet", "--recursive", "git status --porcelain"])) return { reason: "submodules are not clean" };
  if (await occupied(pi, path)) return { reason: "a live agent, pane or process is using it" };
  return { proven };
}

/** Remove a merged record's checkout, then its branch. Returns the blocker, or undefined once removed. */
async function removeWorktree(pi: ExtensionAPI, work: BranchWork): Promise<string | undefined> {
  const { reason, proven } = await blocker(pi, work);
  if (reason) return reason;
  const main = (await registeredWorktrees(pi, work.worktree))[0]!;
  // git refuses initialized submodules without --force; they were verified clean above.
  const submodules = await git(pi, work.worktree, ["submodule", "status", "--recursive"]);
  await git(pi, main, ["worktree", "remove", ...(submodules ? ["--force"] : []), work.worktree]);
  work.status = "removed";
  work.updatedAt = Date.now();
  writeBranchWork(work);
  // -D only when the merged PR head proves nothing is lost (a squash merge leaves the branch "unmerged" to git).
  await git(pi, main, ["branch", proven ? "-D" : "-d", work.branch]).catch(() => undefined);
}

/** Mark open branch work for `repository`'s merged PR head `branch`, so its checkout is removed once unoccupied. */
export async function markBranchWorkMerged(pi: ExtensionAPI, repository: string, branch: string, headOid: string): Promise<void> {
  for (const candidate of listBranchWork().filter((work) => work.branch === branch && (work.status === "open" || work.status === "paused"))) {
    try {
      const origin = await git(pi, candidate.worktree, ["remote", "get-url", "origin"]);
      if (origin.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]?.toLowerCase() !== repository.toLowerCase()) continue;
      await withBranchWorkLock(candidate.repo, branch, async () => {
        const work = readBranchWork(candidate.repo, branch);
        if (work?.status !== "open" && work?.status !== "paused") return;
        work.status = "merged";
        work.mergedHeadOid = headOid;
        work.updatedAt = Date.now();
        writeBranchWork(work);
      });
    } catch { /* Unreadable origin or a held lock: leave the record as it was. */ }
  }
}

/** Retry removal of every merged record; anything still in use or unpushed stays for the next sweep. */
export async function removeMergedWorktrees(pi: ExtensionAPI): Promise<void> {
  for (const candidate of listBranchWork().filter((work) => work.status === "merged")) {
    try {
      await withBranchWorkLock(candidate.repo, candidate.branch, async () => {
        const work = readBranchWork(candidate.repo, candidate.branch);
        if (work?.status === "merged") await removeWorktree(pi, work);
      });
    } catch { /* A held lock or a failed git command: try again next sweep. */ }
  }
}
