import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, freshAccessToken } from "./auth.ts";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const artifactId = UUID.describe("Exact artifact UUID (slug) returned by list_artifacts; short share IDs are not supported.");
const version = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const filePath = z.string().max(1024).refine((path) => path.length > 0 &&
  !/[\\%?#\p{Cc}\p{Cf}]/u.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const file = z.object({ path: filePath, size: z.number().int().nonnegative().optional(),
  contentType: z.string().max(255).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() });
const bootSchema = z.object({ ver: version, assetToken: z.string().min(1), files: z.array(file).max(4096) });
const listingSchema = z.object({ frames: z.array(z.object({ slug: UUID,
  title: z.string().max(4000).optional(), type_title: z.string().max(1024).optional(),
  rel: z.string().max(128).optional(), live: version.optional() })).nullable() });
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

async function native(path: string): Promise<unknown> {
  const token = await freshAccessToken();
  return json(await request(new URL(path, "https://api.anthropic.com"), {
    Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json",
    "X-Frame-CP": "go", "X-Frame-Surface": "code", "X-Frame-Platform": "cli",
    "X-Frame-Client-Version": "2.1.295", "X-Frame-Session-Id": randomUUID(),
  }));
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) fail("Unsupported artifact response schema.");
  return parsed.data;
}

async function boot(slug: string) {
  parse(UUID, slug);
  return parse(bootSchema, await native(`/api/frame/${slug}`));
}

export async function listArtifacts(limit: number) {
  const data = parse(listingSchema, await native(`/api/frame/frames?limit=${limit}`));
  return { untrustedData: true, artifacts: (data.frames ?? []).map((row) => ({
    slug: row.slug, title: row.title, type: row.type_title, rel: row.rel, version: row.live,
  })) };
}

export async function listFiles(slug: string) {
  const data = await boot(slug);
  return { untrustedData: true, slug, version: data.ver, files: data.files };
}

export async function readFile(slug: string, path: string) {
  parse(filePath, path);
  const data = await boot(slug);
  const selected = data.files.find((entry) => entry.path === path);
  if (!selected) fail("File path is not in this artifact's file listing.");
  const host = `${slug}.frame.claudeusercontent.com`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://${host}/_f/${data.ver}/${encodedPath}`);
  if (url.host !== host || url.protocol !== "https:") fail("Untrusted artifact content endpoint.");
  // Only the boot's scoped token goes to the content host, never the account OAuth token.
  url.searchParams.set("__frame_t", data.assetToken);
  const response = await request(url, { Accept: "*/*" });
  const contentType = selected.contentType ?? response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!/^(text\/|application\/(json|javascript|xml|xhtml\+xml)|image\/svg\+xml)/.test(contentType)) {
    await response.body?.cancel();
    fail("Binary file content is not returned by this text-only bridge.");
  }
  const content = (await bytes(response, MAX_RESULT_BYTES)).toString("utf8");
  if (content.split("\n").length > 2000) fail("File exceeds the 2,000-line read limit; no content returned.");
  return { untrustedData: true, slug, version: data.ver, path, contentType,
    content: content.replaceAll(data.assetToken, "<redacted>") };
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
