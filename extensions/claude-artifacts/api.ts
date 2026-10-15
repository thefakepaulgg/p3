import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, freshAccessToken } from "./auth.ts";
import { localText, saveResponse } from "./files.ts";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const artifactId = UUID.describe("Exact artifact UUID (slug) returned by list_artifacts; short share IDs are not supported.");
const version = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const filePath = z.string().max(1024).refine((path) => path.length > 0 &&
  !/[\\%?#\p{Cc}\p{Cf}]/u.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const file = z.object({ path: filePath, size: z.number().int().nonnegative().optional(),
  contentType: z.string().max(255).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() });
const viewerPath = z.string().regex(/^\/artifact\/[A-Za-z0-9_-]+$/);
const bootSchema = z.object({ viewerPath: viewerPath.optional(), ver: version, assetToken: z.string().min(1), files: z.array(file).max(4096),
  title: z.string().max(4000).optional(), favicon: z.unknown().optional() });
const listingSchema = z.object({ frames: z.array(z.object({ slug: UUID,
  title: z.string().max(4000).optional(), type_title: z.string().max(1024).optional(),
  rel: z.string().max(128).optional(), live: version.optional(), softDeleted: z.boolean().optional() })).nullable() });
const MAX_RESULT_BYTES = 100_000; // Connector pattern: about 25,000 tokens; no overflow file is written.
const MAX_JSON_BYTES = 2_000_000;

async function request(url: URL, headers: Record<string, string>): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { fail("Artifact request failed or timed out."); }
  if (!response.ok) {
    await response.body?.cancel();
    fail(`Artifact request failed (HTTP ${response.status}).`);
  }
  return response;
}

async function bytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) fail("Empty artifact response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) fail("Artifact response exceeds the read limit; no content returned.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (length > limit) throw error;
    fail("Could not read artifact response.");
  } finally { await reader.cancel().catch(() => {}); }
}

async function json(response: Response): Promise<unknown> {
  const body = await bytes(response, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString("utf8")); }
  catch { fail("Invalid artifact response."); }
}

async function nativeHeaders(): Promise<Record<string, string>> {
  const token = await freshAccessToken();
  return {
    Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json",
    "X-Frame-CP": "go", "X-Frame-Surface": "code", "X-Frame-Platform": "cli",
    "X-Frame-Client-Version": "2.1.295", "X-Frame-Session-Id": randomUUID(),
  };
}

async function native(path: string): Promise<unknown> {
  return json(await request(new URL(path, "https://api.anthropic.com"), await nativeHeaders()));
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) fail("Unsupported artifact response schema.");
  return parsed.data;
}

export async function boot(slug: string) {
  parse(UUID, slug);
  return parse(bootSchema, await native(`/api/frame/${slug}`));
}

export type ArtifactBoot = Awaited<ReturnType<typeof boot>>;

export function viewer(data: { viewerPath?: string }) {
  return { viewerPath: data.viewerPath, viewer_url: data.viewerPath ? `https://claude.ai${data.viewerPath}` : null,
    viewer_login_required: true,
    viewer_note: "The canonical viewer requires a claude.ai browser login with owner access; API login does not sign in your browser. Use render_preview for local inspection without browser login." };
}

async function mutationViewer(slug: string, data: { viewerPath?: string }) {
  if (data.viewerPath) return viewer(data);
  try {
    const followup = await boot(slug);
    if (followup.viewerPath) return viewer(followup);
  } catch { /* Confirmed mutations stay successful even when the follow-up lookup fails. */ }
  return { ...viewer({}), viewer_note: "The operation succeeded, but its viewer URL could not be resolved. Use list_files to retrieve it; do not retry the mutation." };
}

export async function listArtifacts(limit: number) {
  const data = parse(listingSchema, await native(`/api/frame/frames?limit=${limit}`));
  return { untrustedData: true, artifacts: (data.frames ?? []).filter((row) => row.softDeleted !== true).map((row) => ({
    slug: row.slug, title: row.title, type: row.type_title, rel: row.rel, version: row.live,
  })) };
}

export async function listFiles(slug: string) {
  const data = await boot(slug);
  return { untrustedData: true, slug, version: data.ver, ...viewer(data), files: data.files };
}

export async function readFile(slug: string, path: string) {
  parse(filePath, path);
  const data = await boot(slug);
  const selected = data.files.find((entry) => entry.path === path);
  if (!selected) fail("File path is not in this artifact's file listing.");
  const response = await publishedResponse(slug, data, path);
  const contentType = selected.contentType ?? response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!/^(text\/|application\/(json|javascript|xml|xhtml\+xml)|image\/svg\+xml)/.test(contentType)) {
    await response.body?.cancel();
    fail("Binary file content is not returned by this text-only bridge.");
  }
  const content = (await bytes(response, MAX_RESULT_BYTES)).toString("utf8");
  if (content.split("\n").length > 2000) fail("File exceeds the 2,000-line read limit; no content returned.");
  return { untrustedData: true, slug, version: data.ver, ...viewer(data), path, contentType,
    content: content.replaceAll(data.assetToken, "<redacted>") };
}

// The caller supplies a boot snapshot; only its scoped asset token reaches this fixed content host.
export async function publishedResponse(slug: string, data: ArtifactBoot, path: string) {
  parse(UUID, slug);
  parse(filePath, path);
  if (!data.files.some((entry) => entry.path === path)) fail("File path is not in this artifact's file listing.");
  const host = `${slug}.frame.claudeusercontent.com`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://${host}/_f/${data.ver}/${encodedPath}`);
  if (url.host !== host || url.protocol !== "https:") fail("Untrusted artifact content endpoint.");
  url.searchParams.set("__frame_t", data.assetToken);
  return request(url, { Accept: "*/*" });
}

export async function downloadFile(slug: string, path: string, destination: string) {
  parse(filePath, path);
  const data = await boot(slug);
  const selected = data.files.find((entry) => entry.path === path);
  if (!selected) fail("File path is not in this artifact's file listing.");
  const response = await publishedResponse(slug, data, path);
  try {
    return { slug, version: data.ver, ...viewer(data), path, contentType: selected.contentType,
      ...await saveResponse(response, destination, selected.sha256) };
  } finally { await response.body?.cancel().catch(() => {}); }
}

export const diskFileInput = z.object({ path: z.string().max(1024),
  source: z.string().describe("Explicit absolute path to a local UTF-8 text file (not a symlink); never a secret or credential file"),
  contentType: z.string().max(255).optional() });

export async function writeFilesFromDisk(slug: string, baseVersion: string, sourceRoot: string, files: z.infer<typeof diskFileInput>[]) {
  if (files.length === 0 || files.length > 25) fail("Provide 1-25 files.");
  const loaded = [];
  for (const file of files) loaded.push({ ...file, ...await localText(file.source, sourceRoot, MAX_REQUEST_BYTES) });
  return { ...await deployFiles(slug, baseVersion, loaded, MAX_REQUEST_BYTES), sources: loaded.map(({ path, source }) => ({ path, source })) };
}

// Native text MIME set (Claude Code `ige`); text content is sent inline unchanged, binary is not supported here.
const TEXT_TYPES = new Set(["text/html", "text/css", "text/plain", "text/markdown", "text/csv", "text/javascript",
  "application/javascript", "application/json", "application/manifest+json", "application/xml", "text/xml",
  "image/svg+xml"]);
const MAX_WRITE_FILES = 25;
const MAX_REQUEST_BYTES = 1_000_000; // Everything goes inline in one deploy request; no upload staging.
export const writeFileInput = z.object({
  path: z.string().max(1024).describe("Supporting-file path; existing paths are edited, new paths are added"),
  content: z.string().describe("Full UTF-8 text content for this file (max 100 KB)"),
  contentType: z.string().max(255).optional()
    .describe("Text MIME type. Optional for existing files (current type is kept); required for new files"),
});
const conflictSchema = z.object({ conflict: z.literal(true), live: version, reason: z.string().optional(),
  paths: z.array(z.unknown()).optional() });
const preconditionPath = z.object({ path: z.string(), expected: z.string().nullable(), actual: z.string().nullable() });
const deployedSchema = z.object({ slug: UUID, version, viewerPath: viewerPath.optional() });

export async function writeFiles(slug: string, baseVersion: string, files: z.infer<typeof writeFileInput>[]) {
  return deployFiles(slug, baseVersion, files, MAX_RESULT_BYTES);
}

async function deployFiles(slug: string, baseVersion: string, files: z.infer<typeof writeFileInput>[], perFileLimit: number) {
  parse(UUID, slug);
  if (!version.safeParse(baseVersion).success) fail("Invalid base_version.");
  if (files.length === 0 || files.length > MAX_WRITE_FILES) fail(`Provide 1-${MAX_WRITE_FILES} files.`);
  const seen = new Set<string>();
  for (const entry of files) {
    if (!filePath.safeParse(entry.path).success) fail(`Invalid file path: ${JSON.stringify(entry.path)}.`);
    // A files-only patch never carries the page; native publish refuses index.html in this lane.
    if (entry.path === "index.html") fail("index.html is the artifact's page and cannot be changed by write_files.");
    if (seen.has(entry.path)) fail(`${entry.path} is listed more than once.`);
    seen.add(entry.path);
    if (Buffer.byteLength(entry.content, "utf8") > perFileLimit) fail(`${entry.path} exceeds the ${perFileLimit}-byte per-file limit.`);
  }
  const data = await boot(slug);
  if (data.ver !== baseVersion) fail(`base_version ${baseVersion} is stale; the artifact is at ${data.ver}. ` +
    "Re-read the files and redo the edit against the current version. Nothing was sent.");
  if (data.title === undefined) fail("Could not determine the artifact's current title; nothing was sent.");
  const current = new Map(data.files.map((entry) => [entry.path, entry]));
  const manifest: Record<string, { content: string; contentType: string; ifMatch: string | null }> = Object.create(null);
  for (const entry of files) {
    const existing = current.get(entry.path);
    const contentType = entry.contentType ?? existing?.contentType;
    if (contentType === undefined) fail(`${entry.path} is a new file or has no listed type; provide contentType.`);
    if (!TEXT_TYPES.has(contentType)) fail(`${entry.path}: contentType ${contentType} is not a supported text type.`);
    const sha256 = createHash("sha256").update(entry.content, "utf8").digest("hex");
    if (existing && !existing.sha256) fail(`${entry.path} has no listed sha256 to guard the edit; nothing was sent.`);
    if (existing?.sha256 === sha256 && existing.contentType === contentType) continue; // unchanged: skip, like native
    manifest[entry.path] = { content: entry.content, contentType, ifMatch: existing?.sha256 ?? null };
  }
  const changed = Object.keys(manifest);
  if (changed.length === 0) return { slug, version: data.ver, ...viewer(data), changed, unchanged: true };
  const body = JSON.stringify({ slug, title: data.title, ...(data.favicon ? { favicon: data.favicon } : {}),
    baseVersion, mode: "patch", manifest });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) fail("Update exceeds the 1 MB inline request limit; send fewer files.");

  const unknown = "The update status is unknown: it may or may not have been applied. " +
    "Re-read the artifact with list_files before retrying; do not resend blindly.";
  const headers = { ...await nativeHeaders(), "Content-Type": "application/json" };
  let response: Response;
  try {
    response = await fetch(new URL("/api/frame/deploy/direct", "https://api.anthropic.com"), {
      method: "POST", headers, body,
      redirect: "error", signal: AbortSignal.timeout(60_000),
    });
  } catch { fail(unknown); }
  let reply: unknown;
  try { reply = JSON.parse((await bytes(response, MAX_JSON_BYTES)).toString("utf8")); }
  catch { reply = undefined; }
  if (response.status === 409) {
    const conflict = conflictSchema.safeParse(reply);
    if (!conflict.success) fail("Update refused with a conflict (HTTP 409). Re-read the artifact and redo the edit.");
    const paths = (conflict.data.paths ?? []).flatMap((item) => {
      const parsed = preconditionPath.safeParse(item);
      return parsed.success && seen.has(parsed.data.path) ? [parsed.data.path] : [];
    }).slice(0, 10);
    fail(`Update refused: the artifact changed and is now at version ${conflict.data.live}` +
      (conflict.data.reason === "precondition_failed" && paths.length ? ` (changed files: ${paths.join(", ")})` : "") +
      ". Nothing was applied. Re-read the files, redo the edit against the new version, and pass that version as base_version.");
  }
  if (response.status >= 500) fail(unknown);
  if (!response.ok) fail(`Update rejected (HTTP ${response.status}). Nothing was applied; re-read the artifact before retrying.`);
  const deployed = deployedSchema.safeParse(reply);
  if (!deployed.success || deployed.data.slug !== slug)
    fail("The server accepted the request but its reply was malformed, so the update may have succeeded. Re-read the artifact with list_files to verify.");
  return { slug, version: deployed.data.version, ...await mutationViewer(slug, { viewerPath: deployed.data.viewerPath ?? data.viewerPath }), changed };
}

const typesSchema = z.object({ types: z.array(z.object({ slug: UUID, title: z.string().max(1024).optional(),
  description: z.string().max(4000).optional() })) });
const createdSchema = z.object({ slug: UUID, version, viewerPath: viewerPath.optional() });

export async function listTypes() {
  const data = parse(typesSchema, await native("/api/frame/types"));
  return { untrustedData: true, types: data.types.map(({ slug, title, description }) => ({ slug, title, description })) };
}

// Sends only the title: the server instantiates the type's template (verified live for the Design type).
export async function createArtifact(typeSlug: string, title: string) {
  parse(UUID, typeSlug);
  if (title.length === 0 || title.length > 200) fail("Title must be 1-200 characters.");
  const unknown = "Creation status is unknown: an artifact may or may not have been created. " +
    "Check list_artifacts for the title before retrying; do not resend blindly.";
  let response: Response;
  try {
    response = await fetch(new URL(`/api/frame/types/${typeSlug}/create`, "https://api.anthropic.com"), {
      method: "POST", headers: { ...await nativeHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title }), redirect: "error", signal: AbortSignal.timeout(60_000),
    });
  } catch { fail(unknown); }
  let reply: unknown;
  try { reply = JSON.parse((await bytes(response, MAX_JSON_BYTES)).toString("utf8")); }
  catch { reply = undefined; }
  if (response.status === 429) fail("Creation refused: a rate or daily artifact limit was reached. Nothing was created.");
  if (response.status >= 500) fail(unknown);
  if (!response.ok) fail(`Creation rejected (HTTP ${response.status}). Nothing was created.`);
  const created = createdSchema.safeParse(reply);
  if (!created.success) fail("The server accepted the request but its reply was malformed; an artifact may have been created. Check list_artifacts.");
  return { slug: created.data.slug, version: created.data.version, title, ...await mutationViewer(created.data.slug, created.data) };
}

// Native DELETE /api/frame/{slug}. A deleted artifact 404s afterwards and no restore route was found, so treat it as
// permanent. Requiring the exact current title guards against a wrong UUID.
export async function deleteArtifact(slug: string, confirmTitle: string) {
  parse(UUID, slug);
  const data = await boot(slug);
  if (data.title === undefined || data.title !== confirmTitle)
    fail(`confirm_title must exactly match the artifact's current title (${JSON.stringify(data.title ?? "")}). Nothing was deleted.`);
  let response: Response;
  try {
    response = await fetch(new URL(`/api/frame/${slug}`, "https://api.anthropic.com"), {
      method: "DELETE", headers: await nativeHeaders(), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  } catch { fail("Delete status is unknown: it may or may not have been applied. Check list_artifacts before retrying."); }
  await response.body?.cancel();
  if (response.status >= 500) fail("Delete status is unknown: it may or may not have been applied. Check list_artifacts before retrying.");
  if (!response.ok) fail(`Delete rejected (HTTP ${response.status}). Nothing was deleted.`);
  return { slug, title: data.title, deleted: true };
}

export function result(value: unknown) {
  // Signed content URLs are credentials too, even when embedded in an artifact's text.
  const text = JSON.stringify(value, null, 2).replace(/https?:\/\/[^\s"<>]+/g, (url) => {
    try {
      const parsed = new URL(url);
      return [...parsed.searchParams.keys()].some((key) =>
        /token|signature|credential|^__frame_t$|^x-amz-|^x-goog-|^sig$/i.test(key)) ? "<redacted signed URL>" : url;
    } catch { return url; }
  });
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) fail("Result exceeds the inline limit; no content returned.");
  return { content: [{ type: "text" as const, text }] };
}
