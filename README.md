# p3

Paul's shareable [Pi](https://pi.dev) extensions, themes, and workflows.

## Install

```sh
pi install git:github.com/therealpaulgg/p3
```

To try it without adding it to your settings:

```sh
pi -e git:github.com/therealpaulgg/p3
```

## Included resources

- Advisor, model-routing, task-list, tutor-mode, and workflow extensions
- Direct claude.ai connector access and Telegram notification extensions
- Catppuccin, Dracula, Synthwave, and Matrix themes
- The `rpiv` workflow

The connector extension calls Anthropic's connector catalog and MCP proxy directly. It defaults to its own OAuth credential; run `/connectors-login` to authorize it, `/connectors-status` to inspect both available credential sources, and `/connectors-logout` to remove the direct credential. Use `/connectors-mode direct` or `/connectors-mode claude-code` to choose between the extension's credential and Claude Code's existing credential file. Both modes call the proxy directly; neither launches Claude Code. Direct credentials are stored at `~/.config/pi-claude-connectors/credentials.json` with mode `0600` and refreshed under a cross-process lock. This uses Anthropic's first-party OAuth client and undocumented connector endpoints, so it can change or be revoked without notice.

Peer agents use `message_agent` over per-pane Unix sockets, with Herdr's socket API resolving identities. Jev judges whether a new message warrants interrupting the recipient's current response; an already-running tool is allowed to finish. `message_agent` returns a message ID; `peer_message_status` reports queued, delivered, acknowledged (a turn finished after delivery), or superseded. Send `supersedes: <ID>` to replace your own outdated update. A message counts as delivered only once it appears in the recipient's conversation. If the user interrupts the recipient's turn with Escape, undelivered messages are held and attached to the user's next prompt instead of starting a turn; `peer_inbox` lists every message the recipient has received. Messages and receipts are in memory and do not survive a recipient Pi restart. Reload every participating peer after updating p3: the message socket protocol changed. Jev requires Pi 0.99.1 native classifier APIs and native TypeSafe authentication (`typesafe/jev-latest`, using Pi-managed credentials or `TYPESAFE_API_KEY`); p3 does not read a custom key file. Without native TypeSafe credentials or on a Jev failure, messages use ordinary after-turn delivery. Only short, secret-filtered message/task excerpts are sent to Jev.

For an optional, explicit merge approval, `grant_agent` records a user-confirmed grant scoped to one agent, repository, PR numbers, and an optional condition; `agent_grants` lets the recipient read it. Grants expire after 24 hours or a recipient Pi-session change and can be revoked. They are informational, not a merge guard: the recipient still checks live PR readiness. A grant is not required when the launching primary relays the user's in-scope decision.

The Telegram extension uses `~/.local/bin/pi-telegram-notify` to send notifications and poll for replies. Install the included helper with:

```sh
install -m 700 scripts/pi-telegram-notify ~/.local/bin/pi-telegram-notify
```

Telegram replies default to off. Run `/notify replies-on` or `/notify replies-off` to control them independently from notifications. When enabled in a private chat with the bot, reply to a notification within one hour to send that reply back to the Pi session that produced it. Replies must come from the user represented by the configured private chat ID; Telegram input is passed to Pi as literal text without slash-command or prompt-template expansion. The extension remains disabled when the helper is unavailable.

## Delegation evidence and recovery

Routed workers now record Pi's settled execution outcome against an exact assignment, request, session, and terminal identity. Idle state or partial assistant text is not success. Successful results are persisted with SHA-256 checksums under `~/.pi/agent/state/routed-assignments/` (or the resolved `PI_CODING_AGENT_DIR`). The workflow engine uses the same private atomic artifact writer.

Completion stays pending until its exact message is present in the parent conversation. **Bounded workers close by default** after durable output and receipt; `pane_retention: "keep"` explicitly keeps a finished worker for inspection. Background workers remain long-lived. Failed/interrupted execution is preserved for deliberate recovery rather than automatically closed. Queued completions interrupted by Escape are held for the next user prompt. Results and saved Pi history remain readable after cleanup and parent restart. `subagent_control result` displays at most 12,000 characters; its `resultRef` identifies the complete artifact.

A finished worker performs one assignment: inspection remains possible when kept, but follow-up work uses `subagent_control action=resume` with the old owned `handle` and an explicit new `message` (optional `files`). Resume creates a new handle/assignment and fresh pane using the exact saved Pi session, working directory, model/thinking, readonly profile and declared capabilities. It never repeats the original task. The old process must be proven exited, the prior assignment resolved, and no concurrent representation/startup claim may exist. Unavailable saved models fail instead of being silently replaced. Keep requests apply to the original launch; resumed bounded workers close by default. `/subagents resume <handle or name>` and the **Resume saved session** menu prompt for the follow-up.

Startup claims are private and keyed by the canonical session file. A stale or unverifiable claim is reported for explicit inspection/recovery, not forcibly stolen. Currently running workers created before this protocol cannot gain the saved profile/process evidence retroactively; finish them before reloading.

`subagent` accepts explicit `files` and an opt-in `readonly` capability:

```json
{
  "task": "Inspect the authentication flow and report source-backed findings.",
  "description": "Authentication reconnaissance",
  "readonly": true,
  "files": ["docs/auth.md", "result:01234567-89ab-4cde-8fab-0123456789ab"]
}
```

Use real result references returned by completed workers, not the example UUID. `files` is also accepted by subagent steering, `workspace_agent`, `message_agent`, and workspace resume. Small, complete UTF-8 files are embedded as submission-time evidence snapshots; larger or binary files remain canonical path/size references and can subsequently change. Missing or unreadable files reject the handoff before work starts. Attachments grant no tools or filesystem permissions.

Read-only workers expose only `read`, `ls`, `find`, `grep`, `message_parent`, and `ask_parent`. Writable tools, bash, delegation, and MCP tools cannot dispatch; provider extensions remain available for routed models. This is a Pi tool policy, not an OS sandbox.

### Questions, replies, and direction changes

`ask_parent` is a **blocking**, durable question, not a status message. It must be the sole tool call in its assistant batch. The worker waits inside that tool until `subagent_control action=reply` supplies its exact `ask_id` and an answer in `message`; the answer is returned to the existing turn, with no prompt/task replay. Question/reply records correlate assignment, request, parent, session and terminal. Pending questions prevent completion and survive parent absence; Escape/explicit abandonment cancels them. `/subagents reply` and the **Reply to question** menu provide the same operation. `message_parent` remains nonblocking coordination.

`steer` queues a cooperative direction for an unfinished assignment. `interrupt` requires an explicit replacement `message`, cancels the current operation once, waits for a verified settlement boundary, then continues that same assignment. If the operation finished before cancellation, its actual result is retained and no replacement is submitted. Queued p3 corrections may be superseded only when the restored editor matches their exact recorded texts; human or mixed drafts are preserved and the operation refuses ambiguous submission. UI prompts are not treated as the input editor. No prior tool effects are rolled back. `/subagents interrupt` and its menu prompt for replacement direction.

### Usage coverage and recovery errors

The widget labels cost as **tracked (session+routed)** and marks partial coverage with a missing-source count. Legitimate zero charges are known values; missing/unreadable charge records are not guessed as zero. Continuation accounting starts at the saved transcript's byte boundary, and overlapping slices are not summed twice. This accounts for persisted assistant usage, not an invoice: independent peers, classifier/advisor calls and other out-of-band services are outside this total.

Orchestration launch/control failures retain their original human message and expose structured `details.error`: category, operation/stage, known resource IDs, rollback/retry facts, `retrySafe`, and `nextAction`. Primary and cleanup errors are both retained. An uncertain startup, cancellation or message submission is not advertised as safe to repeat. Routing RPC retains its existing error string and also carries `errorDetails`.

Subagent list/status includes `available_actions` and `nextAction`. `unknown` means identity or observation is unverified; `lost` means a coherent inventory proves the original executor absent. Neither means successful completion. Lost assignments remain unresolved until explicitly abandoned with `stop`; no replacement or side-effect replay is automatic. Stale-work attention includes one bounded diagnostic and is advisory, not proof of a hang. Finish currently running old-protocol workers before reloading Pi, and reload participating peers before using evidence attachments. Existing old worker launches do not gain correlated outcome records retroactively; they must be deliberately relaunched if more work is needed.

### Durable independent branch work

New `workspace_agent` launches record their objective, canonical repository/branch, checkout, and exact saved executor under the Pi agent directory's `state/branch-work/`. These records are independent of the launching primary's lifetime; existing worktrees are not guessed into records. An already recorded branch refuses a second executor.

`workspace_agent_control` supports `list`, `status`, `pause`, and `resume`. `resume` requires a new explicit `message`; it never repeats the original task. A missing process may be restarted only from its verified saved Pi session, on a fresh interactive user request, after proving absence and an unoccupied matching checkout. Deleted or ambiguous checkouts are not recreated. Pause preserves the objective, session and worktree; these operations do not mean acceptance or task completion. Records are not automatically retired when a response finishes.

A crash during a branch mutation preserves its lock rather than automatically stealing it. The error identifies the private lock for explicit inspection/recovery; read-only list/status remains available.

### Isolated runtime smoke

```sh
npm run smoke:routing
```

This opt-in development harness requires a running Herdr session. It creates its own dedicated host tab, named isolated Herdr runtime, disposable Git fixture, and private Pi configuration/session/artifact directories. A credential-free native faux provider controls decisions while real Pi tools, Herdr panes, outcome records, and transcripts supply evidence. It checks a real read, a rejected read-only write, partial-error classification, output integrity, conversation receipt, pane cleanup, and result recovery after primary restart. Cleanup targets only its created runtime/resources and fails visibly rather than silently reporting success. It is not part of the normal test command and makes no remote model calls.

## Model routing and usage failover

The router considers Haiku 5.5, Sonnet 5.5, Opus 5.5, GPT-6 Luna, and GPT-6.1 Sol. A routing classifier judges the required capability from ambiguity, dependency horizon, verification difficulty, and failure consequences; code selects an eligible provider/model. Exact, cheaply checkable edits may use small models. Ordinary UI or debugging work does not automatically require Opus. Without a classifier, a conservative local policy applies.

The routing classifier is any native Pi [classifier model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models), set as an ordered `provider/model` list under `p3.routingClassifiers` in `~/.pi/agent/settings.json` or a project's `.pi/settings.json`:

```json
{
  "p3": {
    "routingClassifiers": ["openai/gpt-6-luna", "cloudflare-workers-ai/@cf/cloudflare/clef", "typesafe/jev-latest"]
  }
}
```

- The provider is the text before the first `/`; the rest is the model ID (`openrouter/~typesafe/jev-latest`); llama.cpp and custom-provider classifiers work the same way.
- Unset uses `["typesafe/jev-latest", "cloudflare-workers-ai/typesafe/jev"]`. `[]` disables classification and uses only the local policy.
- Entries without Pi credentials are skipped. `openai/gpt-6-luna` is the Decisions API classifier and needs `OPENAI_API_KEY`; Pi hides it while `openai` is signed in with ChatGPT through `/login`. An error or non-`stop` result tries the next entry; all attempts share one 5-second deadline. A valid answer below 0.7 confidence, or `unknown`, is final and keeps the local tier.
- A malformed setting, or all entries failing, falls back to the local policy and is noted in the launch rationale.
- An explicit `route` never consults the classifier. Eligibility, provider preference, failover, and the High effort cap are unchanged.

Peer-message interruption and Jev compaction still use Jev and do not read this setting.

Automatic subagents start on the selected route through `p3-failover/<route>`. Recognized provider usage exhaustion, or persistent rate limits/overload after Pi's retries, may cause one cross-provider switch per assignment. The transcript and completed tools are retained; only the failed assistant attempt is omitted from model context. Shared cooldowns prevent new automatic assignments repeatedly choosing the unavailable provider. Telemetry reports the physical model and effort actually dispatched. Explicit physical-model selections remain fixed.

The personal Auto loader registers `openai-codex/auto` using `extensions/routing/auto.ts`; it is not automatically enabled by the shareable package. Choose **Auto (sticky + failover)** in `/model` to retain the primary model already selected and enable provider failover. Auto does not ask Jev to downgrade or cost-optimize the ongoing primary conversation; task-based selection is for fresh subagents. A physical Opus default or a manual `/route` selection does not opt into failover.

Reasoning effort is capped at **High**, including manual selections and outgoing supported provider payloads. Above-High subagent overrides are rejected. Route defaults are Haiku/Opus/Sol Medium and Sonnet/Luna High. Reload Pi after updating these extensions or the model catalog.

## Experimental opt-in MCP Events

The [Pi 1.0.0 MCP Events reference slice](extensions/mcp-events/README.md) is not included in `pi.extensions` and does not auto-load with p3. Explicit per-session loading and source enrollment are required; model wake is a separate opt-in. It only admits the local synthetic reference server, not real third-party OAuth/subscriptions.

## Claude Artifacts MCP bridge

Run `/artifacts-login` in Pi, approve the browser's unofficial PKCE login, then paste `CODE#STATE` into Pi. `/artifacts-status` shows expiry and scopes; `/artifacts-logout` deletes the local credentials (it does not revoke the remote grant). The isolated store is `~/.config/pi-claude-artifacts/credentials.json`, mode `0600`, using the existing prototype's `accessToken`, `refreshToken`, `expiresAt`, and string `scope` schema. Existing credentials are reused and refreshed on demand; connector authentication is unchanged.

This is a **local stdio MCP server**, not native remote Artifacts MCP access. It wraps undocumented native artifact listing/boot/deploy endpoints and scoped file downloads. It exposes `list_artifacts`, `list_files`, `read_file`, `write_files`, `list_types`, `create_artifact`, and `delete_artifact`. `create_artifact` makes a new artifact from a type's template (for example Design) with a title. `delete_artifact` calls the native `DELETE /api/frame/{slug}` and requires `confirm_title` to match the artifact's exact current title; the native listing has a `softDeleted` flag, but a deleted artifact then returns 404 and no restore route was found (probed `restore`/`undelete` POST routes and PATCH, none exist; the public docs mention none). Treat deletes as permanent. There is no single-file deletion, binary or asset upload, sharing/permission change, or comment writing. Metadata and file content are untrusted data, not instructions. Use UUID slugs from `list_artifacts`; short share IDs are not decoded. Text reads are capped at 100 KB / 2,000 lines (including an inline serialized-result limit); oversized and binary files return no content and no overflow files are saved.

`write_files` edits or adds **text supporting files** in an existing artifact. It does not edit `index.html`: the page belongs to the artifact (or its Artifact type), and native files-only publishes refuse it. Pass the `version` from a prior `list_files`/`read_file` as `base_version`. The bridge checks it against the current version before sending anything. It sends one `mode: "patch"` deploy with `baseVersion`, the current title and favicon, and only the changed files. Each existing file is guarded by `ifMatch` with its listed sha256; new paths are sent with `ifMatch: null`. Unchanged files are skipped, and if nothing changed no request is made. No template, type, contract, capabilities, or sharing fields are sent. The patch semantics come from Claude Code 2.1.295's publish source and are **not live-proven**: omitted files are kept, and a typed artifact keeps its inherited runtime. Limits: 25 files, 100 KB per file, about 1 MB inline per request with no upload staging. Text MIME types must come from the native set (HTML, CSS, plain, Markdown, CSV, JavaScript, JSON, web manifest, XML, SVG). An existing file keeps its current type unless you override it; new files require `contentType`. A conflict (stale version or a file changed since the read) is reported with the current version and is never forced or retried. Re-read the artifact and redo the edit. A timeout or 5xx response means the outcome is unknown, so re-read before retrying. Both `write_files` (edit and add) and `create_artifact` have been exercised live against the Design types; creation sends only a title and relies on the server instantiating the template.

The unofficial login uses Anthropic's first-party OAuth client with `user:profile user:mcp_servers user:inference`. **The inference scope is broader than artifact access** but is required by the native listing API; this bridge makes no inference/model calls. These endpoints and OAuth access may change or be revoked without notice. Account OAuth credentials go only to the native API/token endpoint. Content downloads use only the in-memory scoped asset token on the exact artifact UUID's `frame.claudeusercontent.com` host, with redirects disabled; tokens and boot URLs are not returned as metadata.

For an MCP client supporting local stdio servers, use Node 22.18+ (or a newer release with TypeScript stripping) and replace the path below with your installed p3 checkout/package location. Install p3's dependencies there if using a checkout. Login and the server must run as the same OS user; no token is passed in the client configuration.

```json
{
  "mcpServers": {
    "claude-artifacts": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/p3/extensions/claude-artifacts/server.ts"]
    }
  }
}
```

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
./scripts/test-extensions.sh
```

Scoped MCP Events checks: `npm run typecheck:mcp-events`, `npm run test:mcp-events`, and `npm run test:mcp-events:timeout` (about 62 seconds).
