import { constants } from "node:fs";
import { lstat, open, realpath, rm, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, basename, relative, sep } from "node:path";
import { fail, STORE_PATH } from "./auth.ts";

export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

// Exclusive creation never replaces an existing file or follows a destination symlink.
export async function saveResponse(response: Response, destination: string, expectedHash?: string,
  maxBytes = MAX_DOWNLOAD_BYTES) {
  if (!isAbsolute(destination)) fail("destination must be an absolute local file path.");
  const resolved = join(await realpath(dirname(destination)), basename(destination));
  try { await lstat(resolved); fail("destination already exists; downloads never overwrite files."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(dirname(resolved), `.artifact-${randomUUID()}.part`);
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const reader = response.body?.getReader();
  try {
    if (!reader) fail("Empty artifact response.");
    const hash = createHash("sha256");
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail("File exceeds the disk transfer limit.");
      hash.update(value);
      await output.writeFile(value);
    }
    const sha256 = hash.digest("hex");
    if (expectedHash && sha256 !== expectedHash) fail("Published file checksum mismatch; partial download removed.");
    await output.sync();
    await link(temporary, resolved); // Atomic no-clobber publication, including against concurrent creators.
    return { destination: resolved, size, sha256, checksum_verified: expectedHash !== undefined };
  } finally {
    await reader?.cancel().catch(() => {});
    await output.close();
    await rm(temporary, { force: true });
  }
}

export async function localText(source: string, sourceRoot: string, limit: number) {
  if (!isAbsolute(source)) fail("source must be an explicit absolute local file path.");
  if (!(await lstat(source)).isFile()) fail("source must be a regular file, not a symlink or device.");
  if (!isAbsolute(sourceRoot)) fail("source_root must be an explicit absolute local directory.");
  const root = await realpath(sourceRoot);
  const resolved = await realpath(source);
  const within = relative(root, resolved);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    fail("source resolves outside source_root.");
  const name = basename(resolved).toLowerCase();
  if (resolved === STORE_PATH || resolved.split(sep).some((part) => [".ssh", ".aws", "pi-claude-artifacts"].includes(part)) ||
    name.startsWith(".env") || ["credentials", "credentials.json", ".npmrc", ".netrc", "id_rsa", "id_ed25519"].includes(name))
    fail("Credential and secret files cannot be uploaded as supporting files.");
  const input = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > limit) fail("Each source must be a regular UTF-8 text file within the 1 MB inline deploy bound.");
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await input.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > limit) fail("Source exceeds the 1 MB inline deploy bound.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { fail("Source is not valid UTF-8. Native binary upload is not supported."); }
    return { source: resolved, content };
  } finally { await input.close(); }
}
