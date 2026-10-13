import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

/** Shared with workflow outputs: private atomic files, hash and attempt metadata. */
export function atomicWriteArtifact(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function assignmentDirectory(id: string): string {
  if (!UUID.test(id)) throw new Error("Invalid routed assignment identity");
  return join(getAgentDir(), "state", "routed-assignments", id);
}

export type AssignmentOutcome = "running" | "completed" | "aborted" | "error";
export interface AssignmentReceipt {
  version: 1;
  assignmentId: string;
  requestId: string;
  generation: number;
  sessionId: string;
  sessionPath: string;
  paneId: string;
  terminalId: string;
  outcome: AssignmentOutcome;
  lastActivityAt: number;
  responseEntryId?: string;
  resultHash?: string;
  error?: string;
}

export const resultPathForAssignment = (id: string) => join(assignmentDirectory(id), "output.md");
export const resultRefForAssignment = (id: string) => { assignmentDirectory(id); return `result:${id}`; };
export const pathForResultRef = (ref: string) => ref.startsWith("result:") && UUID.test(ref.slice(7)) ? resultPathForAssignment(ref.slice(7)) : undefined;

export function saveAssignmentResult(id: string, generation: number, sessionId: string, responseEntryId: string, text: string): string {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Routed result exceeds 4 MiB");
  const path = resultPathForAssignment(id);
  const hash = hashText(text);
  atomicWriteArtifact(path, text);
  atomicWriteArtifact(join(dirname(path), "output.sha256"), `${hash}\n`);
  atomicWriteArtifact(join(dirname(path), "metadata.json"), JSON.stringify({ assignmentId: id, generation, sessionId, responseEntryId, hash }));
  return hash;
}

export function writeAssignmentReceipt(receipt: AssignmentReceipt): void {
  atomicWriteArtifact(join(assignmentDirectory(receipt.assignmentId), "outcome.json"), JSON.stringify(receipt));
}

export function readAssignmentReceipt(id: string): AssignmentReceipt | undefined {
  try {
    const value = JSON.parse(readFileSync(join(assignmentDirectory(id), "outcome.json"), "utf8")) as AssignmentReceipt;
    if (value.version !== 1 || value.assignmentId !== id || !UUID.test(value.requestId) || !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      !value.sessionId || !value.sessionPath || !value.paneId || !value.terminalId ||
      !["running", "completed", "aborted", "error"].includes(value.outcome) || !Number.isFinite(value.lastActivityAt)) {
      throw new Error("Invalid routed outcome evidence");
    }
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function readAssignmentResult(id: string, expectedHash: string): string {
  const path = resultPathForAssignment(id);
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Routed result exceeds 4 MiB");
  const text = readFileSync(path, "utf8");
  const metadata = JSON.parse(readFileSync(join(dirname(path), "metadata.json"), "utf8"));
  if (hashText(text) !== expectedHash || readFileSync(join(dirname(path), "output.sha256"), "utf8").trim() !== expectedHash ||
    metadata.assignmentId !== id || metadata.hash !== expectedHash) throw new Error("Routed result integrity check failed");
  return text;
}
