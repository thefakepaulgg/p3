import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { branchWorkRoot, readBranchWork, writeBranchWork, listBranchWork, withBranchWorkLock } from "./branch-work.ts";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let testAgentDir = mkdtempSync(join(tmpdir(), "branch-work-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
type BranchWork = import("./branch-work.ts").BranchWork;

afterEach(() => {
  try { rmSync(testAgentDir, { recursive: true, force: true }); } catch { /* ignore */ }
  testAgentDir = mkdtempSync(join(tmpdir(), "branch-work-test-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

const repo = "/canonical/repo/.git";
const branch = "feat/something";

function makeRecord(patch: Partial<BranchWork> = {}): BranchWork {
  return {
    version: 1,
    id: "test-id-1",
    repo,
    branch,
    objective: "implement feature",
    description: "the feature branch work",
    worktree: "/tmp/worktree",
    executor: {
      agent: "agent-1",
      pane: "pane-1",
      terminal: "term-1",
      workspace: "ws-1",
      sessionId: "sess-1",
      sessionPath: "/tmp/session",
    },
    status: "open",
    createdAt: 1000,
    updatedAt: 2000,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Record roundtrip
// ---------------------------------------------------------------------------

describe("record roundtrip", () => {
  test("write then read returns identical record", () => {
    const record = makeRecord();
    writeBranchWork(record);
    const loaded = readBranchWork(repo, branch);
    expect(loaded).toEqual(record);
  });

  test("read returns undefined for nonexistent record", () => {
    expect(readBranchWork(repo, "nonexistent")).toBeUndefined();
  });

  test("write overwrites existing record", () => {
    writeBranchWork(makeRecord());
    const updated = makeRecord({ updatedAt: 9999, status: "paused" });
    writeBranchWork(updated);
    expect(readBranchWork(repo, branch)).toEqual(updated);
  });

  test("list returns all records for a repo", () => {
    writeBranchWork(makeRecord());
    writeBranchWork(makeRecord({ branch: "feat/other", id: "test-id-2" }));
    writeBranchWork(makeRecord({ repo: "/other/repo/.git", branch: "main", id: "test-id-3" }));
    const results = listBranchWork(repo);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.branch).sort()).toEqual(["feat/other", "feat/something"]);
  });

  test("list returns empty array when root dir does not exist", () => {
    expect(listBranchWork(repo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schema validation / malformed records
// ---------------------------------------------------------------------------

describe("malformed records", () => {
  test("corrupt JSON surfaces as error on read", () => {
    writeBranchWork(makeRecord());
    // Overwrite with garbage.
    const root = branchWorkRoot();
    const files = readdirSync(root).filter(f => f.endsWith(".json"));
    writeFileSync(join(root, files[0]), "not json{{{");
    expect(() => readBranchWork(repo, branch)).toThrow(/JSON|Expected|Unexpected|corrupt/);
  });

  test("corrupt JSON surfaces as error on list", () => {
    writeBranchWork(makeRecord());
    const root = branchWorkRoot();
    const files = readdirSync(root).filter(f => f.endsWith(".json"));
    writeFileSync(join(root, files[0]), "{{{bad");
    expect(() => listBranchWork(repo)).toThrow(/JSON|Expected|Unexpected|corrupt/);
  });

  test("write rejects record with wrong version", () => {
    expect(() => writeBranchWork(makeRecord({ version: 2 as any }))).toThrow(/version/);
  });

  test("write rejects record with missing executor fields", () => {
    const bad = makeRecord();
    (bad.executor as any).pane = undefined;
    expect(() => writeBranchWork(bad)).toThrow(/executor/);
  });

  test("write rejects record with invalid status", () => {
    expect(() => writeBranchWork(makeRecord({ status: "completed" as any }))).toThrow(/status/);
  });

  test("read rejects record with repo mismatch", () => {
    writeBranchWork(makeRecord());
    // Read with wrong repo expectation.
    expect(readBranchWork("/wrong/repo", branch)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Collision / replacement guards
// ---------------------------------------------------------------------------

describe("collision guards", () => {
  test("different repo+branch produce different storage keys", () => {
    writeBranchWork(makeRecord());
    writeBranchWork(makeRecord({ repo: "/other/repo/.git", branch, id: "test-id-other" }));
    expect(readBranchWork(repo, branch)!.id).toBe("test-id-1");
    expect(readBranchWork("/other/repo/.git", branch)!.id).toBe("test-id-other");
  });

  test("same repo different branch produce different storage keys", () => {
    writeBranchWork(makeRecord());
    writeBranchWork(makeRecord({ branch: "feat/other", id: "test-id-other" }));
    expect(readBranchWork(repo, branch)!.id).toBe("test-id-1");
    expect(readBranchWork(repo, "feat/other")!.id).toBe("test-id-other");
  });
});

// ---------------------------------------------------------------------------
// Lock behavior
// ---------------------------------------------------------------------------

describe("withBranchWorkLock", () => {
  test("serializes access and returns operation result", async () => {
    const result = await withBranchWorkLock(repo, branch, async () => {
      writeBranchWork(makeRecord());
      return "done";
    });
    expect(result).toBe("done");
    expect(readBranchWork(repo, branch)).toBeDefined();
  });

  test("releases lock after exception", async () => {
    await expect(withBranchWorkLock(repo, branch, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // Lock should be released — a second acquire should succeed.
    const result = await withBranchWorkLock(repo, branch, async () => "ok");
    expect(result).toBe("ok");
  });

  test("concurrent lock on same key fails closed", async () => {
    // Simulate a held lock by creating the lock dir manually.
    const root = branchWorkRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update(`${repo}\0${branch}`).digest("hex");
    const lockPath = join(root, `${key}.lock`);
    mkdirSync(lockPath, { mode: 0o700 });
    // Write info claiming current process (different generation) — simulates live holder.
    writeFileSync(join(lockPath, "info.json"), JSON.stringify({
      pid: process.pid,
      generation: "different-generation",
      acquiredAt: Date.now(),
    }));
    // The same process but different generation should succeed (re-entrant guard uses pid+generation).
    // Actually with our implementation, same pid + same generation = re-entrant.
    // Same pid + different generation = treated as our process owning it, updates acquiredAt.
    // This tests that a live foreign process blocks.
    // Clean up and test with a different pid.
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "info.json"), JSON.stringify({
      pid: 1, // init/launchd — always alive
      generation: "foreign",
      acquiredAt: Date.now(),
    }));
    await expect(withBranchWorkLock(repo, branch, async () => "nope")).rejects.toThrow(/lock held/);
  });
});

// ---------------------------------------------------------------------------
// Status preservation
// ---------------------------------------------------------------------------

describe("status preservation", () => {
  test("does not delete record when executor fields are present but executor process is gone", () => {
    const record = makeRecord({ executor: { agent: "dead", pane: "gone", terminal: "gone", workspace: "gone", sessionId: "gone", sessionPath: "/nonexistent" } });
    writeBranchWork(record);
    const loaded = readBranchWork(repo, branch);
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// branchWorkRoot
// ---------------------------------------------------------------------------

describe("branchWorkRoot", () => {
  test("returns path under agent dir state", () => {
    const root = branchWorkRoot();
    expect(root).toContain("state");
    expect(root).toContain("branch-work");
  });
});

afterAll(() => { rmSync(testAgentDir, { recursive: true, force: true }); if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
