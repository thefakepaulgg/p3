---
name: claude-artifacts
description: Create, edit, and preview Claude Artifacts canvases and UI mockups through p3's claude-artifacts MCP bridge. Use for Artifacts links, canvas creation, private-link preview failures, and all design work: designs, mockups, prototypes, and decks.
---

# Claude Artifacts

Use `claude_artifacts` MCP tools for the current Artifacts canvas workflow. A type named **Design** in `list_types` is an Artifact type.

## Create or resume

1. Discover the available `claude_artifacts` tool schemas. To resume, use `list_artifacts` and the exact UUID slug. To create, call `list_types`, choose the requested type, then `create_artifact` with its UUID and a title. Creation is supported; no spare Untitled canvas is needed. If creation reports an unknown outcome, look for the artifact before retrying.
2. Call `list_files`. Read the canvas's `SKILL.md` and, for a Design canvas, `artifact-type/reference/format.md`. When resuming a canvas, read `project/canvas.json` before changing its layout. Match the app's actual design tokens and any user-specified design system.
3. Follow the canvas's file format using the bridge's actual tools: `write_files` publishes supporting text files, including `project/canvas.json` and `project/*.dc.html`. Pass the returned version as the next `base_version`. Preserve the inherited `index.html` runtime. The native guidance's `Artifact`, `publish`, and asset-upload calls are not bridge tool names; use the discovered bridge capabilities rather than inventing calls.

## Publish and inspect

1. Publish files in batches within the tool's stated limits. Use `write_files_from_disk` for local supporting text files that exceed inline limits, and `download_file` to retrieve large published assets. A stale-version response means re-read and redo the edit; an unknown outcome means inspect before retrying.
2. Call `render_preview` for the published artifact. Open its `serve_url` with the browser tool, select the intended artboard, and inspect the rendered result and requested interactions. This local preview uses MCP authentication server-side and the published DC runtime; the browser needs no claude.ai login. It previews artboards, not the hosted canvas editor or collaboration. Readback or matching hashes verify files, not visual correctness.
3. Return the server-issued `viewer_url` for the user's hosted canvas. It requires a signed-in owner browser; it is separate from `serve_url`. A signed-out 404 is not evidence that publishing failed. If given only a UUID or a short link, resolve it through the supported tools instead of guessing a viewer URL.
4. Return the preview's `expires_at` with its local link. Previews expire after 30 minutes and end when their MCP server exits; call `render_preview` again after expiry or a new publication. Call `stop_preview` with its `preview_id` when it is no longer needed. Local links work on the machine running the MCP server; they are not public share links.

## Limits

- Artifacts OAuth and a claude.ai browser login are separate. Use local preview for agent inspection; hosted validation requires an authenticated browser.
- Keep sharing unchanged unless the user requests a sharing change. A public upload or screenshot gist is not a substitute for private preview.
- Large published files can be downloaded to disk without inserting their full contents into model context. Binary upload and platform capabilities such as comments/collaboration are supported only if the tools explicitly provide them.
- If tools are missing, inspect MCP configuration or reload the updated server. For an authentication failure, ask the user to run `/artifacts-login`; do not fall back to an unrelated Design project.
