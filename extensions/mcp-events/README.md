# Pi 1.0.0 MCP Events — experimental reference slice

Opt-in reference proof, **not universal Events interoperability or a released integration**. This entry is deliberately absent from p3's `pi.extensions`; installing/updating p3 does not load it. No Pi core edits, global settings changes, automatic subscription, OAuth, SignalR, webhook receiver, supervised service or deployment.

Only credential-free `http://127.0.0.1:PORT/mcp` endpoints are admitted; redirects are rejected. Third-party providers and authentication have not been tested.

## Local proofs

From the p3 repository root, using Node 24 (24.18.0 tested):

```sh
bun install --frozen-lockfile --ignore-scripts
npm run typecheck:mcp-events
npm run test:mcp-events          # real HTTP/disk/host tests; long proof skipped
npm run test:mcp-events:timeout  # unchanged SDK 60s timeout control; ~62 seconds
```

The scoped typecheck does not change p3's global compiler target. The full p3 workflow has separately reproduced pre-existing routing-test and ES2022 typecheck failures; passing these feature gates does not mean the whole repository is green.

Evidence is deliberately separated:

- `stream`, `subscription`, `inbox` and `dispatch` tests use real local HTTP/SSE, filesystem checkpoints and lifecycle controls.
- `extension.test.ts` simulates the Pi API boundary; it is not actual host proof.
- `pi-persistence.test.ts` uses the actual Pi 1.0.0 `SessionManager`.
- `pi-host.test.ts` loads **`extensions/mcp-events.ts` through Pi's real file loader** into an actual Pi 1.0.0 `AgentSession`: idle wake, busy follow-up without interruption, transcript receipt ordering, notify-only zero model calls and reload cancellation. The provider is fake; credentials are empty, all tools/global discovery disabled, environment scrubbed, directories temporary and non-loopback fetch denied. No real provider or existing live session is used.
- `timeout.test.ts` proves the Events POST/SSE survives the normal SDK request timeout without changing that timeout.

## Explicit per-session use

For a separately authorized **new/disposable** Pi session, explicitly load the entry, without installing it into settings:

```sh
pi --no-extensions -e /path/to/p3/extensions/mcp-events.ts
```

This command alone is not the credential-isolated test harness above. Do not load the prototype into an existing live session. Factory load/startup does not connect or enroll anything. Within the explicitly loaded session:

- `/mcp-events start http://127.0.0.1:PORT/mcp JOB_ID` subscribes to synthetic `job.completed`, **notify-only**; no model turn.
- Add `wake` to explicitly permit model/tool expenditure within existing user authority. Idle/busy delivery uses `{triggerTurn:true, deliverAs:"followUp"}`, never steering or aborting tools. Event content may then enter the configured model's context; it is still untrusted data, not authorization.
- `/mcp-events status` shows stream/reconnect/cursor/backlog/gap/dedup/receipt state.
- `/mcp-events stop` cancels only the owned stream, releases the lock and retains pending inbox entries.

To deliver retained batches, stop and explicitly restart the same endpoint/job/session identity with `wake`. Restart/reload/fork/new/resume never automatically inherit monitoring or wake authority. Payloads cannot select a session, endpoint, permissions, tools or policy.

Storage is `CTX_CWD/.mcp-events-reference/<identity-sha256>/`, created only on explicit enrollment. Choose a disposable CWD. **These files contain untrusted event payloads/session IDs:** exclude `.mcp-events-reference/` from version control in any other project before use; p3 itself includes that ignore. Tests use temporary directories. Per-inbox limits: 256 pending events, 1 MiB snapshot (bounded before reading/parsing), 1,024 dedup IDs; at most 32 ordered intake writes and one unrecorded batch of 16 events / 64 KiB event JSON plus framing. Overflow pauses, without silently dropping events or checkpointing failed writes.

## Manual reference fixture

```sh
npm run reference:mcp-events
```

An ephemeral loopback port is printed. Local stdin controls: `emit JOB_ID [EVENT_ID]`, `duplicate`, `drop`, `gap`, `silence`, `finish`, `quit`. Events are emitted only on manual request. History is bounded and lost on exit. Quit/EOF/Ctrl-C releases the fixture; it is neither public ingress nor an always-on service.

## Contract and reliability limits

- Events draft pinned to [28ec35e905daa241f019981e2836b4a02f1c0368](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md); tested base revision `2026-07-28`. Modern results require `resultType:"complete"`. Classic/stdio/poll/webhook are outside this slice.
- SDK Client **2.0.0** is owned/version-locked. Protected dispatch hooks intercept only owned string IDs; stream send/abort/end uses public transport APIs, not private request timers. Normal discovery/catalog calls keep their timers. `active` has a 5s deadline; a 60s watchdog expects 30s heartbeats. Only valid events/heartbeats refresh liveness, not SSE comments/errors.
- SDK transport resume is disabled (`maxRetries:0`). SSE IDs differ from application cursors. Cancel old POST, drain admitted writes, then reconnect from the committed cursor with bounded backoff. Retired IDs are ignored. Termination/schema/auth rejection does not blindly retry or switch modes.
- Atomic snapshots commit ordered event/dedup/cursor together with file fsync, rename and directory fsync. Capacity/disk failure prevents later checkpoints; queue overflow drains admitted writes to allow replay progress. Resolve the pause and explicitly restart. `cursor:null` clears replay position; `active.truncated` records a gap, not reconciliation of lost state.
- Dedup is bounded; evicted IDs can recur. At-least-once, **not exactly-once**. Stale `owner.lock` fails closed: verify that specific PID is dead before removing that specific lock. Historical identity directories need operator retention; bounds are per inbox, not aggregate storage.
- Endpoint JSON Schemas are restricted **before Ajv compilation** to a bounded reference profile: `type`, `properties`, `required`, `additionalProperties`, scalar `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `title`, `description`; nested boolean schemas are allowed. Limits: 32 KiB, 64 schema nodes, 8 levels, 32 enum scalars, 64 required names (512 characters each). Unsupported keywords fail closed with an explicit reference-schema error. No regex/format/ref/combinator/array-item extensions, defaults, coercion or remote schema loading. This deliberately rejects otherwise valid third-party JSON Schemas; it is not a general JSON Schema or Events compatibility claim.
- MCP frames are capped at 64 KiB before SDK parsing; catalog at 16 pages × 128 definitions. Fixture request bodies are capped at 64 KiB of UTF-8 bytes.

## Receipts are not successful side effects

`accepted_inbox` means local persistence. Void `sendMessage()` means **queue requested**, not append. `message_end` only means **observed** and occurs before the actual host appends. A later correlated match (session/batch/event/entry IDs) in both `getEntries()` and the actual JSONL file removes entries (**recorded**). Deferred custom-only files and no-session mode cannot ACK.

Transcript scans fail closed above 8 MiB: batches then remain pending and may redeliver after restart. Correlation IDs survive restart to reduce append-before-inbox-ACK duplicates. Asynchronous send failures remain pending until an explicitly rebound dispatcher can redeliver; no speculative re-enqueue into a possibly live queue.

Pi has no fsync/transactional transcript receipt; local fsync is not a macOS full power-loss guarantee. Neither recorded nor `agent_settled` proves obedience or application side effects. Side effects need source-system idempotency or authoritative rereads. Production/third-party auth, aggregate retention and release hardening remain separate scope.
