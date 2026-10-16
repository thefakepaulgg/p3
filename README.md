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

## Background bash

In the interactive TUI, p3 replaces the built-in `bash` tool. A command that finishes within 10 seconds returns exactly the built-in result (same text, renderer, and `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` value). A command still running after 10 seconds keeps running in the Pi process and the tool returns immediately with `{ status: "running", job_id, output, truncated, full_output_path?, wall_time_seconds }` and no `exit_code`, so the agent is free to chat. When the job ends, one `bash-job-complete` message with the exit code (or failure/timeout reason) and the built-in-bounded output (last 2000 lines or 50KB, with a full-output path when truncated) is delivered as a steer and starts a turn if the agent is idle. `bash_job` reads a job's current status and output, or stops it.

- `timeout` keeps its built-in meaning: it kills the command, also after the handoff. The 10-second yield is separate and fixed.
- Execution reuses Pi's own bash factory with the configured `shellPath` and `shellCommandPrefix`, so session tool guards, `PI_*` variables, process-tree killing, and output truncation are unchanged.
- Aborting the turn during the first 10 seconds kills the command. After the handoff, turn completion and Escape leave it running; `bash_job` stop, reload, quit, and new/resume/fork session switches kill it, and no completion is delivered for killed jobs or into a later session.
- The completion message is a custom message, not a tool result: `tool_result` hooks do not see it. p3 applies its advisor secret filter to it instead. `bash_job` output is an ordinary tool result.
- Programmatic callers such as codemode receive the running value instead of awaiting completion. Keep dependent steps in one command (`build && test`).
- Print, JSON, and RPC modes keep the built-in synchronous `bash`, because nothing guarantees the process stays alive to deliver a completion.
- If another extension or SDK tool already provides `bash` (for example a sandbox or remote backend), p3 leaves it in place and shows a warning. p3 checks at `session_start`, after every extension has loaded, so load-time `bash` registrations in any order are detected. A `bash` registered later at runtime by an extension loaded after p3, or an SDK `baseToolsOverride` (reported as built-in), is not detected and would be displaced.
- Jobs are in memory only. They do not survive a Pi crash or restart, and user `!` shell commands are unaffected.

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

### Open saved conversations in Pi

Selecting a worker in `/subagents`, or pressing Enter on its widget row, opens it directly. `/subagents open <handle or name>` does the same: a verified live worker is focused; a finished worker opens its exact saved Pi conversation in an on-demand Herdr tab. No prompt is submitted, no model request is made, and no original task or tool is replayed. Pi supplies its normal conversation rendering, scrolling and `/tree`; there is no custom transcript viewer.

These human-opened sessions preserve the saved model/thinking/working directory and original tool/readonly policy, but are interactive, not read-only viewers. Manual follow-ups append to the conversation without changing the original assignment/result or generating another bounded-worker completion notification. They stay open until you close them. `/subagents close <handle>` closes the reopened session only after checking it is idle with no queued input, modal prompt or unsent editor draft. The widget marks it **Pi open**; secondary controls remain available through the command verbs.

A durable canonical-session claim prevents another p3-mediated `open` or bounded `resume` from creating a second writer. Reopening the same owned session focuses the existing instance, including after parent restart. A pane that switches sessions with `/new`, `/resume` or `/fork` is treated as drift; parent controls refuse rather than controlling the wrong conversation. Unknown claims are not stolen. This cannot prevent manually running another Pi outside p3. New usage is recorded in separate byte windows starting at open, without charging historical turns again.

There is no total subagent count cap. Declared path ownership, dependencies and session identity checks still apply. Routed tabs keep at most four panes each for layout, then overflow into additional tabs; that is not a concurrency limit.

### Questions, replies, and direction changes

`ask_parent` is a **blocking**, durable question, not a status message. It must be the sole tool call in its assistant batch. The worker waits inside that tool until `subagent_control action=reply` supplies its exact `ask_id` and an answer in `message`; the answer is returned to the existing turn, with no prompt/task replay. Question/reply records correlate assignment, request, parent, session and terminal. Pending questions prevent completion and survive parent absence; Escape/explicit abandonment cancels them. `/subagents reply` and the **Reply to question** menu provide the same operation. `message_parent` remains nonblocking coordination.

`steer` queues a cooperative direction for an unfinished assignment. `interrupt` requires an explicit replacement `message`, cancels the current operation once, waits for a verified settlement boundary, then continues that same assignment. If the operation finished before cancellation, its actual result is retained and no replacement is submitted. Queued p3 corrections may be superseded only when the restored editor matches their exact recorded texts; human or mixed drafts are preserved and the operation refuses ambiguous submission. UI prompts are not treated as the input editor. No prior tool effects are rolled back. Pi 1.0 can report an awaited-tool cancellation as `error`: only its exact persisted native abort sentinel plus a matching generation-scoped cancellation intent is normalized to `aborted`. Ordinary errors stay errors; an unsolicited awaited-tool Escape without that intent is preserved as an error for inspection/close/resume, while native streaming aborts remain interrupted. `/subagents interrupt` and its menu prompt for replacement direction.

### Usage coverage and recovery errors

The widget labels cost as **tracked (chat + subagents)**. New workers show **usage pending** until their first usage observation; actual gaps show a separate missing-source count. Legitimate zero charges are known values; missing/unreadable charge records are not guessed as zero. Temporary unavailable observations are rechecked, including restored task windows, rather than permanently labeling valid usage as missing. Continuation accounting starts at the saved transcript's byte boundary, and overlapping slices are not summed twice. This accounts for persisted assistant usage, not an invoice: independent peers, classifier/advisor calls and other out-of-band services are outside this total.

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

This opt-in development harness requires a running Herdr session. It creates its own dedicated host tab, named isolated Herdr runtime, disposable Git fixture, and private Pi configuration/session/artifact directories. A credential-free native faux provider controls decisions while real Pi tools, Herdr panes, outcome records, and transcripts supply evidence. Its 20 behavioral cases exercise a real read/rejected read-only write, literal automatic routing with complete usage coverage, terminal-error classification, output integrity, conversation receipt, cleanup and primary restart; awaited questions/replies including a parent-pane move while blocked; exact saved-session continuation without tool replay and with disjoint usage windows; awaited-tool and streaming interruption; human/mixed draft preservation; a completion-wins race; and unsolicited Escape behavior; native session reopening with zero model calls/history changes, repeated manual turns, lifetime claims, parent restart, sticky session drift, crash recovery, saved model/thinking changes, disjoint attachment/resume billing, and six held workers overflowing into multiple tabs. Models are deterministic faux providers, but Pi tools, sessions, sockets and Herdr processes are real. Every root/worker process must prove OS-denied TCP access. On macOS the harness applies a network-denying `sandbox-exec` profile explicitly to the nested runtime; this is **not** VM or filesystem/process containment. Failed evidence is retained; successful teardown removes only exact owned resources. It is not part of the normal test command and makes no remote model calls. These checks prove the installed Pi/fake-provider boundary, not interoperability with every real provider.

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

`subagent` accepts `route: "auto"` as the same automatic task routing as omitting `route`; it is not a physical model ID or the sticky primary Auto model. Automatic subagents start on the selected route through `p3-failover/<route>`. Recognized provider usage exhaustion, or persistent rate limits/overload after Pi's retries, can switch from an Anthropic subscription to the same Claude model through the Anthropic API key, then to an OpenAI Codex subscription. The API route uses `ANTHROPIC_API_KEY` under the separate `anthropic-api` provider; if the key is unavailable, it is skipped. Automatic OpenAI routes can fall back to Anthropic subscription and then its API key. The transcript and completed tools are retained; only failed assistant attempts are omitted from model context. Shared cooldowns are credential-route-specific, so exhaustion of the subscription does not disable the API key. Telemetry reports the physical model and effort actually dispatched. Explicit physical-model selections remain fixed.

The personal Auto loader registers `openai-codex/auto` using `extensions/routing/auto.ts`; it is not automatically enabled by the shareable package. Choose **Auto (sticky + failover)** in `/model` to retain the primary model already selected and enable provider failover. Auto does not ask Jev to downgrade or cost-optimize the ongoing primary conversation; task-based selection is for fresh subagents. A physical Opus default or a manual `/route` selection does not opt into failover.

Reasoning effort is capped at **High**, including manual selections and outgoing supported provider payloads. Above-High subagent overrides are rejected. Route defaults are Haiku/Opus/Sol Medium and Sonnet/Luna High. Reload Pi after updating these extensions or the model catalog.

## Experimental opt-in MCP Events

The [Pi 1.0.0 MCP Events reference slice](extensions/mcp-events/README.md) is not included in `pi.extensions` and does not auto-load with p3. Explicit per-session loading and source enrollment are required; model wake is a separate opt-in. It only admits the local synthetic reference server, not real third-party OAuth/subscriptions.

## Claude Artifacts MCP bridge

Run `/artifacts-login` in Pi, approve the browser's unofficial PKCE login, then paste `CODE#STATE` into Pi. `/artifacts-status` shows expiry and scopes; `/artifacts-logout` deletes local credentials without revoking the remote grant. Credentials are isolated in `~/.config/pi-claude-artifacts/credentials.json` (mode `0600`), reused and refreshed on demand. Connector authentication is unchanged.

This is a **local stdio MCP server** wrapping undocumented native Artifacts APIs, not the legacy Claude Design MCP. The bundled [Claude Artifacts skill](skills/claude-artifacts/SKILL.md) describes the create → publish → browser-preview workflow. The type called **Design** belongs to Artifacts; it is not a legacy Design project.

### Create and open a canvas

1. Discover `claude_artifacts` tools. Use `list_artifacts` to resume a canvas, or `list_types` → `create_artifact` to create one.
2. Read its file listing, `SKILL.md`, and applicable format references. Design canvases store their editable state in `project/canvas.json` and `project/*.dc.html`; preserve the inherited `index.html` runtime.
3. Publish supporting files with `write_files`, passing the latest returned version as `base_version`. Follow the bridge's actual tool schemas rather than copying native `Artifact` tool arguments from the canvas guidance.
4. Use `render_preview` and open the returned `serve_url` in the agent's browser. It uses authenticated downloads server-side and requires no claude.ai browser login. It expires after 30 minutes or MCP server exit; use `stop_preview` for earlier cleanup and render a fresh preview after publishing changes.
5. Give the user the server-issued `viewer_url` for the hosted canvas. **Hosted viewer links require the owner's signed-in claude.ai browser.** They are separate from local preview links. A signed-out 404 is not evidence of a failed publication; viewer links must never be guessed from UUIDs.

Preview serves published content without changing artifact sharing. Local URLs are accessible on the MCP server's machine, not public share links. The Design preview renders published artboards with their actual DC runtime and an artboard selector, not the hosted canvas editor. Local rendering does not establish that hosted collaboration, comments, or other platform capabilities work.

### Files and concurrency

Inline `read_file` is limited to text, 100 KB / 2,000 lines including the serialized-result limit. Use `download_file` for larger or binary published files instead of feeding them through model context. Returned metadata and contents are untrusted data, not instructions.

`write_files` adds or edits supporting text files, not `index.html`. It checks `base_version` before sending a `mode: "patch"` deploy with the current title/favicon and changed files only. Existing files carry their listed sha256 as `ifMatch`; new files use `null`. Unchanged files are skipped. Omitted files and inherited runtime are preserved; template, type, contract, capabilities and sharing fields are not sent. Inline limits are 25 files, 100 KB/file and about 1 MB/request. `write_files_from_disk` accepts explicit local supporting-text paths under `source_root`, bypassing the model-inline per-file limit while retaining the 1 MB deploy-request bound and concurrency guards. This removes the bridge's 100 KB obstacle for component scripts without dumping them into model context; larger native writes have not been live-published in this change, and binary upload remains unsupported. Existing files retain their MIME type unless overridden; new files need a supported text MIME type.

On a conflict, re-read and redo the edit against the current version. Timeouts, malformed success replies and 5xx responses can mean an unknown outcome: inspect before retrying, including after creation. There is no forced retry. There is no binary asset upload, single-file deletion, sharing change or comment-writing tool. `delete_artifact` requires the exact current title as `confirm_title`; treat deletion as permanent because no restore route is known.

### Authentication and configuration

The unofficial login uses Anthropic's first-party OAuth client with `user:profile user:mcp_servers user:inference`. **Inference scope is broader than artifact access**, but the native listing API requires it; the bridge makes no model calls. These undocumented endpoints can change or be revoked without notice. Account OAuth credentials go only to the native API/token endpoint. Published-file downloads use the scoped asset token on the exact artifact UUID's `frame.claudeusercontent.com` host with redirects disabled. Credentials and signed URLs are not returned in tool results.

For a local stdio MCP client, use Node 22.18+ (or newer with TypeScript stripping), install p3's dependencies, and set the path to your installed checkout. Login and server must run as the same OS user; no token belongs in this configuration. After updating, reload the MCP server/Pi so the new tools and bundled skill are available.

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
