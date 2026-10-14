import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteArtifact } from "./artifacts.ts";
import { orchestrationError } from "./errors.ts";
import type { ThinkingLevel } from "./policy.ts";

/**
 * Durable human-attachment store. Kept free of continuation imports so continuation can
 * consult the per-canonical-session claim without an import cycle.
 */
export type AttachmentStatus = "starting" | "open" | "closed" | "unknown" | "failed";

export interface AttachmentRecord {
  version: 1;
  attachmentId: string;
  parentSessionId: string;
  /** Handle of the immutable source task (handle === sourceHandle); the task record itself is never rewritten. */
  handle: string;
  sourceHandle: string;
  sourceAssignmentId?: string;
  /** Canonical (realpath) saved Pi session. */
  sessionPath: string;
  sessionId: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinking: ThinkingLevel;
  readonly?: boolean;
  capabilities?: Array<"memory">;
  label: string;
  status: AttachmentStatus;
  tabId?: string;
  paneId?: string;
  terminalId?: string;
  agentName?: string;
  workerPid?: number;
  openedAt: number;
  closedAt?: number;
  /** Append-only JSONL byte window [usageStartOffset, usageOffset) owned by this attachment. */
  usageStartOffset: number;
  usageOffset: number;
  estimatedCost: number;
  costKnown: boolean;
  costComplete: boolean;
  error?: string;
}

/** Written only by the attached Pi process. */
export interface AttachmentPresence {
  attachmentId: string;
  pid: number;
  sessionId: string;
  sessionPath: string;
  paneId: string;
  startedAt: number;
  /** The attached process left the claimed session (/new, /resume, /fork); control is refused. */
  drift?: { reason: string; sessionId?: string; sessionPath?: string; at: number };
  /** Clean shutdown while still on the claimed session; bytes is the session size at that moment. */
  shutdown?: { reason: string; at: number; bytes: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const root = () => join(getAgentDir(), "state", "routed-attachments");
const attachmentDirectory = (id: string) => {
  if (!UUID.test(id)) throw new Error("Invalid attachment identity");
  return join(root(), "records", id);
};
const claimDirectory = (sessionPath: string) => join(root(), "claims", createHash("sha256").update(realpathSync(sessionPath)).digest("hex"));
const readJson = (path: string): any => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

export const attachmentSocketPath = (id: string) => join(tmpdir(), `p3-attach-${process.getuid?.() ?? "local"}-${createHash("sha256").update(id).digest("hex").slice(0, 20)}.sock`);

export function readAttachmentRecord(id: string): AttachmentRecord | undefined {
  const value = readJson(join(attachmentDirectory(id), "record.json")) as AttachmentRecord | undefined;
  if (value && (value.version !== 1 || value.attachmentId !== id || !value.sessionPath || !value.sessionId || !value.parentSessionId)) throw new Error("Invalid attachment record");
  return value;
}
export const writeAttachmentRecord = (record: AttachmentRecord) => atomicWriteArtifact(join(attachmentDirectory(record.attachmentId), "record.json"), JSON.stringify(record));

export const readAttachmentControlToken = (id: string): string | undefined => readJson(join(attachmentDirectory(id), "control.json"))?.token;
export const writeAttachmentControlToken = (id: string, token: string) => atomicWriteArtifact(join(attachmentDirectory(id), "control.json"), JSON.stringify({ token }));

export function readAttachmentPresence(id: string): AttachmentPresence | undefined {
  const value = readJson(join(attachmentDirectory(id), "worker.json")) as AttachmentPresence | undefined;
  return value?.attachmentId === id && Number.isSafeInteger(value.pid) && value.pid > 0 ? value : undefined;
}
export const writeAttachmentPresence = (presence: AttachmentPresence) => atomicWriteArtifact(join(attachmentDirectory(presence.attachmentId), "worker.json"), JSON.stringify(presence));

export function listParentAttachments(parentSessionId: string): AttachmentRecord[] {
  let ids: string[];
  try { ids = readdirSync(join(root(), "records")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return ids.filter((id) => UUID.test(id)).map((id) => { try { return readAttachmentRecord(id); } catch { return undefined; } })
    .filter((record): record is AttachmentRecord => record?.parentSessionId === parentSessionId)
    .sort((a, b) => a.openedAt - b.openedAt);
}

/** The attachment currently holding this canonical session, if any. A closed record no longer holds it. */
export function sessionAttachment(sessionPath: string): { claim: { attachmentId: string; parentSessionId: string }; record?: AttachmentRecord } | undefined {
  const claim = readJson(join(claimDirectory(sessionPath), "claim.json"));
  if (!claim) {
    try { readdirSync(claimDirectory(sessionPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    // Directory without owner file: a claim being created or a crash mid-claim. Never guessed away.
    return { claim: { attachmentId: "unknown", parentSessionId: "unknown" } };
  }
  let record: AttachmentRecord | undefined;
  try { record = readAttachmentRecord(claim.attachmentId); } catch { /* unreadable record keeps the claim held */ }
  return record?.status === "closed" ? undefined : { claim, record };
}

/** Used by continuation: a saved session with a live or unresolved human attachment has no second writer. */
export function assertSessionUnattached(sessionPath: string): void {
  const held = sessionAttachment(sessionPath);
  if (!held) return;
  throw orchestrationError(new Error(`Saved session is attached for human use (attachment ${held.claim.attachmentId}, status ${held.record?.status ?? "unverified"})`), "resume", {
    category: "session_attached", stage: "session_claim", retrySafe: false, ids: { sessionId: held.record?.sessionId },
    nextAction: "Close the attachment from its owning parent first. An unverifiable attachment claim is never stolen automatically.",
  });
}

/** Exclusive for the whole attachment lifetime. Callers hold withSessionStartLock. */
export function claimSessionForAttachment(record: AttachmentRecord): void {
  const directory = claimDirectory(record.sessionPath);
  mkdirSync(join(root(), "claims"), { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({ attachmentId: record.attachmentId, parentSessionId: record.parentSessionId, sessionId: record.sessionId, sessionPath: record.sessionPath });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readJson(join(directory, "claim.json"));
      if (attempt === 0 && previous && !sessionAttachment(record.sessionPath)) { releaseSessionClaim(previous.attachmentId, record.sessionPath); continue; }
      assertSessionUnattached(record.sessionPath);
      throw new Error("Attachment claim exists without verifiable ownership");
    }
    writeFileSync(join(directory, "claim.json"), owner, { flag: "wx", mode: 0o600, flush: true });
    return;
  }
}

/** Releases only the exact attachment's claim. */
export function releaseSessionClaim(attachmentId: string, sessionPath: string): void {
  const directory = claimDirectory(sessionPath);
  if (readJson(join(directory, "claim.json"))?.attachmentId !== attachmentId) return;
  unlinkSync(join(directory, "claim.json"));
  rmdirSync(directory);
}
