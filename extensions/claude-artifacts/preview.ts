import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, publishedResponse, viewer } from "./api.ts";
import { saveResponse } from "./files.ts";
import { fail } from "./auth.ts";

const LIMITATIONS = "Read-only published DC artboard preview, not the hosted canvas/editor. No editing, collaboration, comments, AI, database, asset-service or other Claude capability APIs. Only published supporting files are available; external images/fonts/styles need network access. Refresh by rendering a new preview after publishing changes.";
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const LIFETIME_MS = 30 * 60 * 1000;
const previews = new Map<string, { server: Server; directory: string; timer: NodeJS.Timeout }>();
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const serialize = (data: unknown) => JSON.stringify(data).replaceAll("<", "\\u003c");

function shell(boards: { path: string; title: string; width: number; height: number }[], initial: string | undefined,
  prefix: string, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Artifact preview</title>
<style>body{margin:0;background:#e9e9ed;color:#202028;font:14px system-ui}header{position:sticky;top:0;z-index:1;background:#fff;padding:12px 20px;border-bottom:1px solid #ccc}h1{font-size:18px;margin:0 0 8px}p{margin:8px 0;max-width:1000px}select{font:inherit;max-width:70vw;padding:6px}main{padding:24px;overflow:auto}iframe{border:0;background:white;box-shadow:0 2px 14px #0002}#status{margin-left:12px}</style></head><body>
<header><h1></h1><label>Published artboard <select aria-label="Published artboard"></select></label><span id="status"></span><p id="limitations"></p></header><main><iframe title="Published DC artboard" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></main>
<script>const boards=${serialize(boards)},prefix=${serialize(prefix)};document.querySelector('h1').textContent=${serialize(title)};document.querySelector('#limitations').textContent=${serialize(LIMITATIONS)};
const select=document.querySelector('select'),frame=document.querySelector('iframe'),status=document.querySelector('#status');
for(const board of boards){const option=document.createElement('option');option.value=board.path;option.textContent=board.title+' — '+board.path;select.appendChild(option)}
function show(){const board=boards.find(b=>b.path===select.value);if(!board){frame.hidden=true;status.textContent='No published .dc.html artboards yet. Add one with write_files.';return}frame.hidden=false;frame.width=board.width;frame.height=board.height;status.textContent='Loading DC runtime…';frame.src=prefix+'files/'+board.path.split('/').map(encodeURIComponent).join('/')}
select.value=${serialize(initial ?? boards[0]?.path ?? "")};select.addEventListener('change',show);window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;if(event.data?.type==='__dc_booted'&&event.data.mounted)status.textContent='DC runtime mounted · '+frame.width+' × '+frame.height;if(event.data?.type==='__dc_render_errors'&&event.data.errors?.length)status.textContent='DC runtime reported render errors; some components may be unavailable.'});show();</script></body></html>`;
}

export async function renderPreview(slug: string, initialPath?: string) {
  const data = await boot(slug);
  if (!data.files.some((file) => file.path === "artifact-type/dc-runtime.js"))
    fail("This artifact has no published DC runtime. Local preview currently supports Design DC artboards only.");
  const directory = await mkdtemp(join(tmpdir(), "p3-artifact-preview-"));
  await chmod(directory, 0o700);
  const cached = new Map<string, Promise<string>>();
  let reserved = 0;
  async function localFile(path: string) {
    let pending = cached.get(path);
    if (!pending) {
      const file = data.files.find((entry) => entry.path === path);
      if (!file) fail("File is not published in this snapshot.");
      const budget = file.size ?? MAX_FILE_BYTES;
      if (budget > MAX_FILE_BYTES || reserved + budget > MAX_CACHE_BYTES) fail("Preview cache transfer limit reached.");
      reserved += budget;
      pending = (async () => {
        const destination = join(directory, createHash("sha256").update(path).digest("hex"));
        const response = await publishedResponse(slug, data, path);
        try {
          const saved = await saveResponse(response, destination, file.sha256, Math.min(MAX_FILE_BYTES, budget));
          reserved += saved.size - budget;
          return destination;
        } finally { await response.body?.cancel().catch(() => {}); }
      })();
      cached.set(path, pending);
    }
    return pending;
  }
  let server: Server | undefined;
  try {
    let metadata: Record<string, { title?: unknown; w?: unknown; h?: unknown }> = {};
    if (data.files.some((file) => file.path === "project/canvas.json" && (file.size ?? 0) <= 2_000_000)) {
      try { metadata = JSON.parse(await readFile(await localFile("project/canvas.json"), "utf8")).boards ?? {}; }
      catch { /* Files remain previewable even if optional canvas metadata is unavailable. */ }
    }
    const dimension = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value)
      ? Math.max(64, Math.min(10000, Math.round(value))) : fallback;
    const boards = data.files.filter((file) => file.path.startsWith("project/") && file.path.endsWith(".dc.html") && !file.path.startsWith("project/ds/"))
      .map((file) => {
        const meta = metadata?.[file.path.slice("project/".length)];
        return { path: file.path, title: typeof meta?.title === "string" ? meta.title : file.path,
          width: dimension(meta?.w, 800), height: dimension(meta?.h, 800) };
      });
    if (initialPath && !boards.some((board) => board.path === initialPath)) fail("path must be a published project .dc.html artboard.");
    // Fetch the actual published runtime server-side, never through the model or with a browser token.
    await localFile("artifact-type/dc-runtime.js");
    const prefix = `/${randomBytes(24).toString("hex")}/`;
    let host = "";
    const localCsp = (artifact: boolean) => [
      "default-src 'none'", `script-src http://${host} 'unsafe-inline' 'unsafe-eval'`,
      `connect-src http://${host}`, `style-src http://${host} https: 'unsafe-inline'`,
      `font-src http://${host} https: data:`, `img-src http://${host} https: data: blob:`,
      `media-src http://${host} https: data: blob:`, "object-src 'none'", "form-action 'none'",
      `base-uri http://${host}`, artifact ? "sandbox allow-scripts" : `frame-src http://${host}`,
    ].join("; ");
    server = createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      try {
        if (req.headers.host !== host || !["GET", "HEAD"].includes(req.method ?? "") ||
          !req.url?.startsWith(prefix) || /[?#]/.test(req.url)) { res.writeHead(404).end(); return; }
        const relative = req.url.slice(prefix.length);
        if (relative === "") {
          res.setHeader("Content-Security-Policy", localCsp(false));
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(req.method === "HEAD" ? undefined : shell(boards, initialPath, prefix, data.title ?? "Artifact preview"));
          return;
        }
        if (!relative.startsWith("files/") || /%2f|%5c/i.test(relative)) { res.writeHead(404).end(); return; }
        const path = decodeURIComponent(relative.slice("files/".length));
        const file = data.files.find((entry) => entry.path === path);
        if (!file) { res.writeHead(404).end(); return; }
        const local = await localFile(path);
        res.setHeader("Access-Control-Allow-Origin", "*"); // Opaque sandbox origin; no cookies or credentials.
        res.setHeader("Content-Security-Policy", localCsp(true));
        res.setHeader("Content-Type", file.contentType ?? "application/octet-stream");
        if (req.method === "HEAD") { res.end(); return; }
        if (path.endsWith(".dc.html")) {
          const html = await readFile(local, "utf8");
          if (!/<head(?:\s[^>]*)?>/i.test(html)) { res.writeHead(422).end("Artboard needs an HTML head."); return; }
          res.end(html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<script src="${prefix}files/${encodePath("artifact-type/dc-runtime.js")}"></script>`));
        } else {
          const stream = createReadStream(local);
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
        }
      } catch { if (!res.headersSent) res.writeHead(502); res.end("Published preview file could not be loaded. Render a fresh preview if it expired."); }
    });
    const listening = server;
    await new Promise<void>((resolve, reject) => { listening.once("error", reject); listening.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") fail("Could not start local preview.");
    host = `127.0.0.1:${address.port}`;
    const previewId = randomUUID();
    const timer = setTimeout(() => { void stopPreview(previewId); }, LIFETIME_MS);
    timer.unref();
    previews.set(previewId, { server, directory, timer });
    return { slug, version: data.ver, ...viewer(data), preview_id: previewId,
      serve_url: `http://${host}${prefix}`, board_count: boards.length,
      expires_at: new Date(Date.now() + LIFETIME_MS).toISOString(), limitations: LIMITATIONS };
  } catch (error) {
    server?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function stopPreview(previewId: string) {
  const preview = previews.get(previewId);
  if (!preview) fail("No active preview with that preview_id in this server process.");
  previews.delete(previewId);
  clearTimeout(preview.timer);
  preview.server.closeAllConnections();
  await new Promise<void>((resolve) => preview.server.close(() => resolve()));
  await rm(preview.directory, { recursive: true, force: true });
  return { preview_id: previewId, stopped: true };
}

export async function stopAllPreviews() {
  await Promise.all([...previews.keys()].map(stopPreview));
}

process.once("exit", () => {
  for (const preview of previews.values()) {
    try { rmSync(preview.directory, { recursive: true, force: true }); } catch { /* Best-effort exit cleanup. */ }
  }
});
