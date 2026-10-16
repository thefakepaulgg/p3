# Ten-second shell auto-backgrounding: replace `bash` or add a tool?

## Recommendation

**Prefer a separate, directly discoverable shell tool initially; leave built-in `bash`'s completion contract intact.** Apply the chosen ~10-second foreground window to that tool, not background-everything behavior. This is a recommendation for the user's tool-surface decision, not an implementation proposal.

Overriding `bash` is an officially supported mechanism and retains session guards and normal shell rendering. The objection is **semantics and backend composition**, not API availability: today `await tools.bash(...)` means the command finished and supplies a numeric exit code. Returning a running-job acknowledgement after ten seconds breaks that contract, including dependent commands inside codemode. A later custom message cannot finish the already-resolved promise or replace its tool result. An override also does not automatically inherit another extension's sandbox or SDK-supplied backend. [B1–B4, C1–C3, D1–D4]

A separate tool does **not** make all existing `bash` calls automatically yield. If that is the desired scope, an override is the appropriate supported surface, but it must be an explicit breaking change to the bash result/instruction contract, with backend integration proved first. No user decision is assumed here.

## Evidence scope

Static inspection only, on 2026-10-15. CLI `pi` resolves through `/Users/agent/.bun/bin/pi` to the installed **@earendil-works/pi-coding-agent 1.3.0** bundle. Sources below are the installed official package's readable emitted JavaScript, public declarations, docs, and examples; not an inferred upstream checkout. p3 inspected at commit `5394e9a9e2a6ebce451d9ace3f5b3e7abd500d2e`, with current working-tree files authoritative for integration observations. p3's manifest lists Pi **1.0.0** development dependencies and `*` peers; this research establishes installed 1.3.0 behavior, not compatibility with every supported peer version. [A1, P1]

No commands were executed through a candidate shell implementation, no runtime proof was run, and no packages, production code, configuration, or tests were changed. The only intended written artifact is this note.

### Citation roots

- `PI` = `/Users/agent/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`
- `CM` = `/Users/agent/.bun/install/global/node_modules/@earendil-works/pi-codemode`
- `P3` = `/Users/agent/.pi/agent/git/github.com/therealpaulgg/p3`

All citations below mean exact absolute paths formed with these roots and the indicated installed line ranges.

## Findings

### 1. Same-name registration really replaces the built-in

**Yes.** Official `tool-override.ts` explicitly documents same-name replacement. Session registry construction starts with built-ins, then `Map.set(name, ...)` replaces both the definition and executable implementation with extension tools. This is not merely a second model declaration with a colliding name. [B1, B2]

Important limits:

- Across extensions, **first registration per name wins** in the runner's extension order. Within one extension, registering again replaces its map entry and refreshes tools. SDK `customTools` are appended after extension registrations in session registry construction and can win there. It is not a universal last-loaded-wrapper chain. [B2, B3]
- There is no documented “call original bash” handle in the inspected `ExtensionAPI`. `getAllTools()` gives metadata, not the displaced executable. `ctx.executeTool("bash", ...)` from a `bash` override resolves the override again, not the original; it is not a delegation strategy. The supported factory constructs a new implementation. [B2, C1, C2, D1]

### 2. Tool guards and renderers survive—within their actual scope

**Yes for model and nested session tool calls.** `AgentSession` owns `beforeToolCall`/`afterToolCall`, emits `tool_call` and `tool_result`, and passes the replacement tools through those same hooks. Registered-tool wrapping supplies context; it is not what implements the guards. Nested calls run the same tool pipeline with parent IDs. [C1, C2]

**Yes for normal TUI shell rendering.** Interactive mode resolves the active definition through `withBuiltInRenderers`; missing `renderCall`/`renderResult` fall back to shell renderers for the name `bash`. `createBashToolDefinition` also includes the renderers directly. A new tool name has no name-based shell fallback, but can reuse the definition's renderers. [B4, D1]

This does **not** imply a live background-job UI. The existing result renderer displays text, truncation/full-output details, and elapsed tool-call time. Once a running acknowledgement is returned, that call is complete; a completion sent later is a custom message with its own rendering, not a second shell result. [B4, E1]

Guard preservation is also **not automatic guarding of later completion output**: `sendMessage` enters the custom-message path, not `_afterToolCall`. A `tool_result` redactor will see the early acknowledgement but does not thereby redact the eventual custom completion. Nor does a direct factory `.execute()` call independently emit tool guards; the outer session call supplies them. [C1, D2, E1]

### 3. Codemode reaches the override, but its contract changes

**Yes.** Codemode builds its callable tool list from `ctx.tools` and invokes `ctx.executeTool(tool.name, args, {signal})`. The callable registry contains the selected replacement; active `direct` tools are callable, as are registered `codemode`/`deferred` tools. Nested execution validates and invokes session hooks. [C1–C3]

The official documented bash value is `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`. The factory's output schema requires a numeric `exit_code`; it awaits `ops.exec` before constructing it. A running job has no exit code yet. **Spreading the original definition and changing only execute to return a job handle does not preserve its declared output schema.** Returning a fake success exit code would be worse: a script could run its next dependent step before the command finishes. [C3, D1]

Codemode explicitly cancels calls still pending when the script ends. A nested call that has already returned a job acknowledgement is no longer such a pending call; the host must own its background work and cancellation deliberately. Codemode's pending-call cancellation is not a background-job lifecycle service. [C4]

### 4. What the Bash factories actually let p3 reuse

Both factories are public root exports in this installation. [A2]

| API | What is actually reusable | What it does not provide |
|---|---|---|
| `createBashToolDefinition(cwd, options)` | Full `ToolDefinition`: parameters, prompt metadata, output schema, execute, shell renderers. Execute accepts session context. | No job handle, yield-after option, process handle, public incremental output accumulator, or attachment to the session's existing bash implementation. |
| `createBashTool(cwd, options)` | An `AgentTool` wrapping the definition, plus prompt snippet/guidelines. Useful as an execution delegate. | The wrapper drops renderer fields. A directly called instance has no generated session context unless one is supplied; it does not create guard events itself. |
| `BashToolOptions` / `BashOperations` | Explicit `operations`, `commandPrefix`, `shellPath`, session-environment exposure and synchronous `spawnHook`; `operations.exec` streams bytes and eventually returns an exit code. | No standard “still running” result, backend lookup, suspend/resume, poll, cancellation handle, or async completion callback. |

Evidence: [D1, D2]. The definition uses `ctx?.cwd || cwd`, resolves environment/spawn hook, accumulates and throttles output, and only finishes after the operations promise settles. Local operations kill the process tree on abort/timeout and track detached children until completion. **Setting bash `timeout: 10` kills the command; it does not background it.** [D1, F1]

A timer racing the factory execution could return first while retaining the promise, but that is **extension-owned architecture**, not a factory feature. Late update callbacks, rejected promises, ownership transfer, output storage and shutdown would still need explicit handling. An `operations.exec` implementation cannot return early with a real running-job state without violating the factory's exit-code contract. [D1, D2]

### 5. Sandbox, hooks, and custom backends are not inherited by magic

**No blanket preservation guarantee.** A fresh `createBashTool(ctx.cwd)` defaults to local operations. Existing custom `BashOperations` and `spawnHook` are only used if explicitly supplied to that factory. Session-created built-ins receive configured `shellCommandPrefix` and `shellPath`; a freshly constructed replacement does not automatically receive those settings. `pi.getSettings()` is public, but backend closures are not exposed there by this tool API. [D1, D3]

The official sandbox example itself registers `bash` and explicitly delegates to a factory with `operations: createSandboxedBashOps()`. Its separate `user_bash` handler is for user shell commands. If another `bash` registration wins instead, the sandbox tool's execution path is displaced—not automatically composed. The same problem applies to remote/SDK backend replacements. Session-level `tool_call` checks continue to run, but are not equivalent to preserving a sandboxed execution backend. [B2, B3, D4]

User `!`/RPC shell handling is a distinct route: a model-tool override does not replace it. Official docs describe `user_bash` propagation independently; interactive user-shell execution emits that event and calls `session.executeBash`. Neither a separate model tool nor a model `bash` override should be claimed to cover every shell entry point. [D5]

### 6. Early return plus later message: supported building blocks, not a deferred tool result

**Yes as two separate events.** `ToolDefinition.execute` can return a normal result; the public `pi.sendMessage` API can later send a custom message with `triggerTurn` and `steer`/`followUp`/`nextTurn` delivery. Busy-session delivery queues/steers; idle `triggerTurn: true` starts a custom-message run. `triggerTurn: false` appends when idle or defers safely while busy. There is no tool-call identifier in that API for completing/reopening the previous tool result. [E1]

p3 already uses asynchronous custom notifications and shutdown cleanup in PR watching and model routing, providing local integration precedent—not proof of shell process management. [P2]

**Cancellation/shutdown needs implementation, regardless of tool name.** During an active factory call the provided signal reaches local process-tree cancellation. Session replacement aborts active work, emits `session_shutdown`, then invalidates/disposes the old runtime; shutdown reasons include quit/reload/new/resume/fork. Local detached children are also tracked for signal cleanup. Those facilities do not define an extension job's ownership after its tool returned. A background job needs session-scoped cleanup, cancellation policy, and suppression of completion after invalidation; a stale captured context cannot be used after replacement. No SIGKILL/crash-recovery durability guarantee is established. [F1–F3]

Print/JSON mode loads extensions too, but a custom message API is not a promise that a one-shot process stays alive to await extension jobs. Treat delayed completion in noninteractive modes as unproved until a focused host proof. [F4]

## p3 surface comparison

| Consideration | Override `bash` | Separate directly exposed tool |
|---|---|---|
| Existing instructions/call sites | Same name; reaches existing `bash` callers automatically, but changes meaning of awaited completion. | Existing `bash` calls remain unchanged; requires explicit description/prompt guidance to choose the new ~10-second-yield tool. |
| Discovery | Already familiar active name. | `direct` is activated on registration and callable while active; use `promptSnippet`/`promptGuidelines`. Codemode `searchTools`, `ALL_TOOLS`, `describeTool` expose callable tools. Merely `deferred` would be less visible. |
| Existing name-based guards | Existing `bash` guards still match. | Generic deny-by-default p3 guards cover it, but any external bash-only permission rule needs auditing. |
| Read-only / Tutor Mode | Remains blocked. | Also blocked unless deliberately added to allowlists; do not add it. |
| Sandbox/backend | Can collide with an existing override. | Avoids displacing it, but a new local shell backend can still bypass it; separate name alone is not sandbox integration. |
| Programmatic result | Must explicitly change existing bash schema and expectations. | Can honestly declare a completed-or-running result without changing built-in bash. |

The discovery and prompt mechanisms above are official APIs [C3, G1]. p3 loads extensions from its manifest; it currently lists no shell override there. Its read-only worker policy permits only `read`, `ls`, `find`, `grep`, `message_parent`, `ask_parent`, projects those active tools and rejects every other name at `tool_call`. Tutor Mode similarly blocks names outside its allowlist. Both names remain disallowed through session-dispatched nested calls. This is tool policy, not an OS sandbox, and cannot police arbitrary extension-internal process spawning. [P1, P3]

## Small proof needed after the user chooses—not run here

Use one credential-free isolated host fixture, not the user's live session: a fast command and a >10-second command through direct calls and codemode; verify one acknowledgement and one later completion, honest output schema, preserved block/result-redaction behavior (including completion handling), explicit configured backend/spawn-hook invocation, and process-tree cleanup on cancellation/reload/session switch. Include the codemode dependent-command case to expose changed `await bash` semantics. Check actual extension-order behavior with the sandbox/backend expected in the target setup. Only if required, add a print-mode delayed-completion case. These are the concrete unresolved runtime risks; no broad implementation or suite is proposed.

## Source index

- **A1:** `PI/package.json:1–20` (version/entry points).
- **A2:** `PI/dist/index.d.ts:20–26` (public factories/types).
- **B1:** `PI/examples/extensions/tool-override.ts:1–17,68–76` (official replacement example).
- **B2:** `PI/dist/core/agent-session.js:2841–2897` (definition/executable replacement; SDK precedence).
- **B3:** `PI/dist/core/extensions/runner.js:410–430`; `PI/dist/core/extensions/loader.js:231–240` (collision/re-registration rules).
- **B4:** `PI/dist/modes/interactive/interactive-mode.js:1705–1707`; `PI/dist/core/tools/renderers/index.js:16–45`; `PI/dist/core/tools/renderers/bash.js:23–86` (renderer fallback/presentation).
- **C1:** `PI/dist/core/agent-session.js:318–416` (direct/nested hooks and execution).
- **C2:** `PI/dist/core/extensions/wrapper.js:1–20`; `PI/dist/core/extensions/runner.js:696–720`; `PI/dist/core/agent-session.js:1142–1152` (context and callable selection).
- **C3:** `PI/dist/extensions/codemode/execute.js:366–375,401–432`; `PI/docs/codemode.md:31–43`; `PI/docs/extensions.md:147–165` (programmatic values, discovery/exposure).
- **C4:** `PI/docs/codemode.md:18`; `CM/dist/runtime/execution.js:337–349` (pending-call cancellation).
- **D1:** `PI/dist/core/tools/bash.js:28–46,135–175,180–230,255–331` (schema, environment, output, factory behavior).
- **D2:** `PI/dist/core/tools/bash.d.ts:35–98`; `PI/dist/core/tools/tool-definition-wrapper.js:1–36`; `PI/dist/core/extensions/types.d.ts:261–280` (options, wrappers/context limits).
- **D3:** `PI/dist/core/agent-session.js:2934–2947`; `PI/dist/core/extensions/types.d.ts:1282–1286` (configured base tools and settings API).
- **D4:** `PI/examples/extensions/sandbox/index.ts:208–232`; `PI/examples/extensions/ssh.ts:121,175–180` (explicit backend delegation).
- **D5:** `PI/docs/extensions.md:128`; `PI/dist/modes/interactive/interactive-mode.js:5869–5927`; `PI/dist/modes/rpc/rpc-mode.js:439–457` (separate user-shell paths).
- **E1:** `PI/dist/core/extensions/types.d.ts:1257–1261`; `PI/dist/core/agent-session.js:1810–1871`; `PI/dist/core/extensions/loader.js:301–309` (custom message contract/delivery and stale-runtime guard).
- **F1:** `PI/dist/core/tools/bash.js:48–122`; `PI/dist/utils/shell.js:137–187` (abort/timeout/process tracking).
- **F2:** `PI/dist/core/agent-session-runtime.js:102–113,296–303`; `PI/dist/core/agent-session.js:996–1008,2965–2975`; `PI/dist/core/extensions/types.d.ts:636–642` (shutdown/invalidation).
- **F3:** `PI/docs/extensions.md:220,261–267`; `PI/dist/modes/interactive/interactive-mode.js:3579–3596` (stale context, cleanup and signals).
- **F4:** `PI/docs/extensions.md:251–256`; `PI/dist/modes/print-mode.js:15–47` (mode/resource scope).
- **G1:** `PI/docs/extensions.md:155–183` (exposure and prompt/loadout APIs).
- **P1:** `P3/package.json:14–29,54–65` (loaded extensions and dependency declarations).
- **P2:** `P3/extensions/github-pr-watch.ts:331–354,682–688`; `P3/extensions/model-routing.ts:418–422,1139–1157` (async messages/cleanup precedent).
- **P3:** `P3/extensions/routing/worker-policy.ts:7–27,43–69`; `P3/extensions/tutor-mode.ts:11–25,238–244`; `P3/README.md:61` (allowlists, enforcement and sandbox distinction).
