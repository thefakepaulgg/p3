import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteArtifact } from "./artifacts.ts";

export interface BranchWork {
  version: 1;
  id: string;
  repo: string;
  branch: string;
  objective: string;
  description: string;
  worktree: string;
  executor: { agent: string; pane: string; terminal: string; workspace: string; sessionId: string; sessionPath: string };
  status: "open" | "paused";
  createdAt: number;
  updatedAt: number;
}

export const branchWorkRoot = () => join(getAgentDir(), "state", "branch-work");
const keyFor = (repo: string, branch: string) => createHash("sha256").update(`${repo}\0${branch}`).digest("hex");
const recordPath = (repo: string, branch: string) => join(branchWorkRoot(), `${keyFor(repo, branch)}.json`);

function validateRecord(value: unknown, repo: string, branch: string): BranchWork {
  const record = value as BranchWork | undefined;
  if (!record || record.version !== 1 || !record.id || !repo || !branch || record.repo !== repo || record.branch !== branch ||
    !record.worktree || typeof record.objective !== "string" || !record.objective.trim() || typeof record.description !== "string" ||
    !["open", "paused"].includes(record.status) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
    !record.executor || ["agent", "pane", "terminal", "workspace", "sessionId", "sessionPath"].some((field) => {
      const value = record.executor[field as keyof BranchWork["executor"]];
      return typeof value !== "string" || !value;
    })) throw new Error("Invalid branch-work record or executor identity");
  return record;
}

export function readBranchWork(repo: string, branch: string): BranchWork | undefined {
  try { return validateRecord(JSON.parse(readFileSync(recordPath(repo, branch), "utf8")), repo, branch); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function listBranchWork(repo: string): BranchWork[] {
  let names: string[];
  try { names = readdirSync(branchWorkRoot()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records: BranchWork[] = [];
  for (const name of names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
    const value = JSON.parse(readFileSync(join(branchWorkRoot(), name), "utf8"));
    if (value.repo !== repo) continue;
    const record = validateRecord(value, repo, value.branch);
    if (name !== `${keyFor(repo, record.branch)}.json`) throw new Error("Branch-work record filename conflicts with its identity");
    records.push(record);
  }
  return records;
}

export function writeBranchWork(record: BranchWork): void {
  validateRecord(record, record.repo, record.branch);
  atomicWriteArtifact(recordPath(record.repo, record.branch), JSON.stringify(record));
}

/** No stale-lock guessing: a crash during a mutation preserves the lock for explicit recovery. */
export async function withBranchWorkLock<T>(repo: string, branch: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(branchWorkRoot(), { recursive: true, mode: 0o700 });
  const path = join(branchWorkRoot(), `${keyFor(repo, branch)}.lock`);
  const token = randomUUID();
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Branch-work lock held at ${path}. Verify its recorded executor/process before explicitly recovering the lock; no work was replayed.`);
    throw error;
  }
  try {
    writeFileSync(join(path, "info.json"), JSON.stringify({ pid: process.pid, generation: token, acquiredAt: Date.now() }), { mode: 0o600, flag: "wx", flush: true });
    return await operation();
  } finally {
    const current = JSON.parse(readFileSync(join(path, "info.json"), "utf8"));
    if (current.generation === token && current.pid === process.pid) { unlinkSync(join(path, "info.json")); rmdirSync(path); }
  }
}
