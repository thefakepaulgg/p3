import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentDirectory, hashText, pathForResultRef, readAssignmentReceipt, readAssignmentResult, resultPathForAssignment, resultRefForAssignment, saveAssignmentResult, writeAssignmentReceipt, type AssignmentReceipt } from "./artifacts.ts";

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  dir = mkdtempSync(join(tmpdir(), "routing-artifacts-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const receipt = (assignmentId = randomUUID()): AssignmentReceipt => ({
  version: 1, assignmentId, requestId: assignmentId, generation: 1, sessionId: "session", sessionPath: "/session.jsonl",
  paneId: "w1:p2", terminalId: "terminal", outcome: "running", lastActivityAt: 1,
});

test("receipt and output paths live in the isolated agent state directory", () => {
  const value = receipt();
  writeAssignmentReceipt(value);
  expect(assignmentDirectory(value.assignmentId)).toBe(join(dir, "state", "routed-assignments", value.assignmentId));
  expect(readAssignmentReceipt(value.assignmentId)).toEqual(value);
  expect(statSync(join(assignmentDirectory(value.assignmentId), "outcome.json")).mode & 0o777).toBe(0o600);
  expect(statSync(assignmentDirectory(value.assignmentId)).mode & 0o777).toBe(0o700);
  expect(readAssignmentReceipt(randomUUID())).toBeUndefined();
});

test("successful output round-trips with hash and attempt metadata", () => {
  const id = randomUUID();
  const hash = saveAssignmentResult(id, 2, "session", "response", "Full response\n");
  expect(hash).toBe(hashText("Full response\n"));
  expect(readAssignmentResult(id, hash)).toBe("Full response\n");
  expect(pathForResultRef(resultRefForAssignment(id))).toBe(resultPathForAssignment(id));
  expect(JSON.parse(readFileSync(join(assignmentDirectory(id), "metadata.json"), "utf8"))).toEqual({ assignmentId: id, generation: 2, sessionId: "session", responseEntryId: "response", hash });
});

for (const artifact of ["output.md", "output.sha256", "metadata.json"] as const) {
  test(`rejects mutated ${artifact}`, () => {
    const id = randomUUID();
    const hash = saveAssignmentResult(id, 1, "session", "response", "original");
    writeFileSync(join(assignmentDirectory(id), artifact), artifact === "metadata.json" ? JSON.stringify({ assignmentId: randomUUID(), hash }) : "mutated");
    expect(() => readAssignmentResult(id, hash)).toThrow("integrity check failed");
  });
}

test("rejects non-UUID assignment paths and malformed request evidence", () => {
  expect(() => assignmentDirectory("../escape")).toThrow("Invalid routed assignment identity");
  expect(pathForResultRef("result:../escape")).toBeUndefined();
  const value = receipt();
  writeAssignmentReceipt({ ...value, requestId: "not-a-uuid" });
  expect(() => readAssignmentReceipt(value.assignmentId)).toThrow("Invalid routed outcome evidence");
});
