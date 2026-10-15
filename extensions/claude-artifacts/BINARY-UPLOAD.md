# Binary supporting files

## Native protocol evidence

Inspected the embedded JavaScript in the installed `@anthropic-ai/claude-code`
2.1.295 Mach-O (`bin/claude.exe`, resolved from `which claude`) using `strings`.
The native `ige` set identifies text types; `Tn` adds the binary MIME types now
listed in `api.ts`. Native `on(file)` returns UTF-8 text unchanged for `ige`,
otherwise `Buffer.toString("base64")`. There is **no `encoding` field**.

Small files use the existing direct deploy endpoint, including binary files:

```json
POST /api/frame/deploy/direct
{
  "slug": "<artifact UUID>",
  "title": "<current title>",
  "baseVersion": "<observed version>",
  "mode": "patch",
  "manifest": {
    "assets/example.png": {
      "content": "<base64 of raw PNG bytes>",
      "contentType": "image/png",
      "ifMatch": null
    },
    "assets/existing.ttf": {
      "content": "<base64 of raw TTF bytes>",
      "contentType": "font/ttf",
      "ifMatch": "<previous raw-byte sha256>"
    }
  }
}
```

The bridge preserves the current favicon when present. Hashing and downloads
operate on decoded/raw bytes, not the base64 string.

Native large-file flow (observed in bundle, not exercised or added here):

1. `POST /api/frame/deploy/prepare` with `{slug, shas: ["<raw sha256>"]}`;
   expects `{slug, missing: ["<raw sha256>"]}`.
2. `POST /api/frame/upload` with `{slug, files: [{path, content, contentType}]}`
   for missing hashes; binary `content` is the same base64 string. Upload results
   include `files[].sha256`.
3. Direct deploy replaces each staged manifest entry's `content` with `sha256`,
   retaining `contentType` and patch preconditions.

Native constants: binary per-file `atr` = 15 MiB, serialized request `ir` =
20 MiB, inline content budget `gr` = 12 MiB, upload batching budget `Qt` =
15 MiB of encoded content, raw publish total `n5` = 64 MiB, version total
`wSt` = 256 MiB, 256 entries/publish and 512/version. No presigned URLs are
needed for this path. This bridge intentionally retains 25 files and 1 MB per
text file, accepts up to 15 MiB per binary file and caps the entire serialized
disk deploy at 20 MiB, including JSON/base64 overhead. It does not stage or split
requests automatically; a file/batch exceeding the wire bound must be shrunk or
split. Inline model-supplied text publishing retains its old limits.

## Verification

Base: live commit `5394e9a`; fetched `fork` main did not contain the
`extensions/claude-artifacts` implementation, so the live commit was chosen.
Neither the live server checkout's tracked files nor the dev checkout were edited.

A separate stdio MCP client launched this worktree's `server.ts` with Node's
`--experimental-strip-types`, using existing auth without exposing credentials.
Created Design `bridge binary upload test`, UUID
`362498b5-aeea-4ccf-b72b-7be72b8ebb86`, published a text `.dc.html` plus:

| File | Bytes | SHA-256 | Listed type |
| --- | ---: | --- | --- |
| sample.png | 99 | 3dc61c5406872e21531ea574c6b1afa5fa0ef718c50493ec19666bf425509efd | image/png |
| SplineSansMono-Regular.ttf | 51156 | 582dca32242cd7d12d8b9fedc483dfa8602dd4df7bd17ac5d76b6b789b63705e | font/ttf |

`list_files` matched both source hashes and types. `download_file` returned
byte-identical files and verified checksums. Re-publishing identical disk files
returned `unchanged: true`. Preview proxy GETs returned the same bytes and exact
MIME types. No preview code change was needed: non-artboard files are already
streamed unchanged with the listed content type.

`agent_browser` opened the preview and its published artboard; observed heading
"Binary bridge works", PNG natural dimensions 32 × 32, and the Spline font face
in `loaded` state with computed font-family `Spline`. A separate named browser
session was used for final evidence after the shared browser changed tabs.
Screenshot: `/tmp/p3-binary-upload-output/binary-preview.png`.
Detailed local evidence: `/tmp/p3-binary-upload-output/evidence.json` and
`browser-state.json`. The scratch preview was stopped and the scratch artifact
was deleted with `delete_artifact` using its exact title; its UUID was absent
from the subsequent artifact listing. No existing artifact was modified.

`node_modules/.bin/tsc -p tsconfig.extensions.json` passed, using a temporary
node_modules symlink to the dev checkout's installed dependencies (removed afterwards). No test suites
were run. Other MIME types, maximum-size requests, staging and hosted editor
behavior were not live-tested.

## Use this checkout without changing the live checkout

1. Make dependencies available without changing either existing checkout:
   `ln -s /Users/agent/workspace/p3/node_modules /Users/agent/workspace/p3-artifacts-binary/node_modules`.
   Alternatively install this worktree's dependencies with the repo's package manager.
2. In `/Users/agent/.pi/agent/mcp.json`, change only
   `mcpServers.claude-artifacts.args[1]` from the live checkout's `server.ts` to
   `/Users/agent/workspace/p3-artifacts-binary/extensions/claude-artifacts/server.ts`.
   Keep `command: "node"`, `--experimental-strip-types`, and the existing timeout.
3. Restart/reload that MCP server (or restart Pi), then inspect
   `write_files_from_disk`'s tool description: it should mention binary files,
   15 MiB per binary file and 20 MiB serialized total. Use this checkout's updated
   `skills/claude-artifacts/SKILL.md` for agent guidance; the installed skill is
   unchanged until this commit is installed there.
4. To revert the server switch, restore the previous args path and reload it.

No push, PR, MCP configuration edit or live checkout installation was performed.
