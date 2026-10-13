# pi-herdsman versus p3: architecture, practical tradeoffs, and lessons

## Verdict

**pi-herdsman is materially ahead as a durable project/agent coordination system. It is not a strict upgrade over p3, and its architecture is not fundamentally different at the process or worktree layer.**

Both use real Pi conversations in visible Herdr panes. Both use Herdr's worktree/workspace model rather than inventing an independent project tree. The difference is the coordination contract above that substrate:

- **p3:** a user-facing primary launches bounded workers, explicitly creates independent worktree peers, chooses/routes models, and can run declarative workflows. Independent peers remain directly usable by the human. Connections and coordination are deliberately scoped.
- **Herdsman:** a normal Lead launches definition-based Agents; optional Managers coordinate durable branch assignments executed by Leads; an optional Chief supervises across the runtime. Assignment identity, ownership, questions, results, and recovery are first-class orchestration state.

For work that must remain intelligible and manageable through controller replacement, paused branch execution, missing processes, and delayed results, **Herdsman has the stronger design**. Calling this merely a mild difference would understate its work on lifecycle correctness.

For task-based model selection, provider-exhaustion handling, enforced declared dependency prerequisites, and configurable workflow approvals, **p3 has capabilities that Herdsman does not currently implement in its own orchestration layer**. Its globally discoverable same-role peers also make a different coordination-boundary choice from p3.

There is no evidence here that Herdsman's agents produce better code, finish faster, or cost less on matched tasks. Those require comparative execution, not counting features or GitHub stars.

**Recommendation:** keep p3's pane-native, explicit, human-directed model. Borrow Herdsman's stronger execution-outcome, delivery, evidence, and work-identity contracts before considering its role hierarchy. A durable task does not require a Chief.

## Scope and evidence quality

Inspected snapshots:

- Herdsman `main` / version **0.26.0**, commit [`897810003200ed68475e0aac2cb8cf09d4f5ea91`](https://github.com/boadij/pi-herdsman/commit/897810003200ed68475e0aac2cb8cf09d4f5ea91), released 2026-10-12.
- p3 local checkout at `9c48a92f36b02db1a215e816e7089319b3699196`, with an existing uncommitted change to `extensions/routing/failover.ts`. That file was left untouched. Existing committed failover was checked separately; the basic failover capability does **not** depend on the dirty additions.

Research included implementation traces, relevant regression-test definitions, architecture decisions, operational documentation, current issue descriptions, and CI history. The scope is the competing orchestration surfaces, not every unrelated p3 extension.

No dependencies were installed, competitor processes launched, test suites run, or comparative benchmarks performed. A successful upstream CI run is attributed as upstream evidence, not represented as a locally reproduced pass. Code-path concerns below are explicitly static findings, not claims of reproduced production incidents.

## 1. The underlying architecture is closer than the marketing suggests

### p3

```text
Human ↔ primary Pi session
          ├─ bounded subagent → Pi in a Herdr pane
          ├─ bounded subagent → Pi in a Herdr pane
          └─ explicitly launched independent peer
                 └─ separate Herdr worktree workspace
```

`subagent` records dependencies, owned paths, model/effort, result-delivery state, and pane retention. `workspace_agent` creates or opens a worktree through Herdr, starts an independent Pi, and records the launch relationship. These are different lifetimes: a subagent wakes the primary on completion; an independent peer remains available and has no automatic task-completion callback. [P1][P2]

### Herdsman

```text
Normal use:       Human ↔ Lead → Agent → optional leaf Agent

Project mode:     Human ↔ Manager
                           ├─ branch A → Lead → Agents
                           └─ branch B → Lead → Agents

Optional fleet:   Human ↔ Chief → Managers / unassigned Leads
```

These are still Herdr-managed Pi processes, not invisible embedded agents. Herdsman's default is an ordinary **Flexible Lead**, not a mandatory Chief/Manager hierarchy; Manager auto-activation is off. Direct Agents get fresh tabs by default (`subtree`), and nested Agents split in the owner's tab. [H1][H2]

**Important bound:** current source supports **Lead → delegating Agent → leaf Agent**. Agent-started Agents have their delegation policy removed. This is not unlimited recursive delegation, notwithstanding broader wording in an open graph proposal. [H2][H3]

**Important commonality:** both create worktree workspaces using Herdr's source-project/worktree-group operations. Herdsman's added concept is a durable assignment *within* that project group, not a replacement for project inheritance. [P2][H4]

The genuinely different abstractions are:

1. **Ownership:** which exact Pi session owns a bounded Agent assignment.
2. **Supervision:** which Manager controls an assigned Lead; which Chief supervises Managers and ordinary unassigned Leads.
3. **Placement:** where Herdr currently displays/runs that session.

Herdsman deliberately keeps these separate. Pane proximity does not grant authority. A Manager does not own a Lead's Agents just because it supervises the Lead. [H1]

## 2. Capability comparison

| Dimension | p3 inspected behavior | Herdsman inspected behavior | Assessment |
|---|---|---|---|
| Visible workers | Real Pi sessions in Herdr panes | Real Pi sessions in Herdr panes | Shared foundation, not an advantage unique to either |
| Worktree provenance | Herdr source project; explicit independent peers | Herdr worktree group; optional branch assignment | Shared physical model; Herdsman adds durable work semantics |
| Normal user session | Primary can work and delegate | Flexible Lead can work and delegate | No basis to call either inherently more human-friendly |
| Branch work across controller turnover | Launch relationships/messages, but no equivalent branch-assignment ledger | Repo + branch assignment with exact executing Pi session | Clear Herdsman advantage for continued managed branch work |
| Worker restart recovery | Persisted task telemetry/manifests; reconnect active watchers | Durable requests/results/ownership plus fresh identity reconciliation | Both persist; Herdsman's recovery contract is richer |
| Completion correctness | Herdr settlement + transcript text + abort detection | Correlated Pi outcome and response identity | Herdsman stronger; consequential p3 static gap below |
| Delivery | Subagent claim-based dedup; peer receipts in memory | Durable pending records; history evidence before cleanup | Herdsman stronger restart/delivery semantics, not globally exactly-once |
| Models | Task capability routing, explicit fixed choices, bounded automatic cross-provider failover | Definition-configured or inherited model/thinking; native Pi/provider behavior | p3 has a distinct built-in routing/failover layer |
| Dependency structure | `depends_on` launch validation; workflow `needs`, approvals, persisted runs; one active step per workflow | Ordering primarily instructions; child-completion gates | p3 stronger explicit structure, not parallel workflow execution; dependent on truthful completion |
| Parallel write scope | Optional `owned_paths` collision rejection in the primary's same-cwd registry | Prompt-level non-overlap rules; no equivalent declared path reservation found | p3 useful narrow guard, not a filesystem/global lock |
| Nested bounded work | Routed workers cannot launch routed descendants | One nested Agent level, allowlisted and gated | Herdsman supports a useful additional decomposition pattern |
| Read-only specialists | Task instructions; no equivalent per-task read-only profile on `subagent` | Bundled scout/reviewer native tool allowlists exclude writes and bash | Herdsman stronger capability restriction at the Pi tool boundary |
| Questions | Nonblocking `message_parent`, general steering | Durable `ask_owner`/correlated reply blocks settlement | Herdsman stronger explicit decision boundary |
| Course correction | `steer` sends a Herdr prompt; `stop` sends Escape | Distinct cooperative `steer_agent`, preemptive `interrupt_agent`, correlated `reply_agent` | Herdsman makes correction/cancellation/answer semantics more explicit; p3 already has steering |
| Peer discovery | Parent/child, connected siblings, or explicit user-directed named connection | User-global same-role Lead/Manager discovery across sockets | Different policy; p3 narrower, Herdsman more discoverable |
| Long-lived helper | Explicit `mode: background`, idle is not completion | Managed Agent is one assignment; Leads carry durable project lifetime | Different lifetime contracts, not interchangeable definitions of “background” |
| Context pressure | Jev-assisted retention during native compaction | Retire managed assignment before threshold compaction, fresh follow-up | Different fidelity/continuity tradeoff; no demonstrated winner |
| Observability | Task widget, model/cost, retained panes, focus/result controls | Ownership tree, tool eligibility, transcripts, health attention, scoped usage accounting | Herdsman richer orchestration observability; p3 is not bare/manual-only |
| Public product surface | Shareable personal extension collection | Focused orchestration package, configuration UI, extensive docs, installer/container, cross-platform CI | Herdsman more developed distribution/documentation surface |

The narrower rows matter more than a single score. “Has more features” is not the same as “fits this workflow better.”

## 3. Where Herdsman is substantively stronger

### 3.1 Work identity survives the process that happened to start it

Herdsman's `ProjectAssignment` is keyed by repository and semantic Git branch, and binds the assignment to an exact Pi session. Its representation contains the task, session file, and imported result bindings. Atomic assignment writes include file/directory synchronization. [H5]

This lets the system distinguish:

- open work from a finished conversational response;
- stopped execution from resolved work;
- a closed Herdr workspace from a deleted Git checkout;
- a replacement Manager from a replacement assignment;
- an existing branch from a currently managed assignment.

A Lead response does **not** close the project assignment. `stop_lead` pauses the executor/tree and preserves the assignment. `resume_project` resolves the existing branch assignment instead of blindly creating another writer. Current activation checks reject an already occupied matching Lead workspace. Confirmed takeover releases supervision without deleting the worktree or conversation. [H4][H5]

This is more than launch convenience. It is a coherent answer to “Who is working on this branch, and what do I do after the coordinator disappears?”

p3 already has restart restoration for routed tasks; it is wrong to describe it as having no persistence. But its independent peer launch does not establish this durable branch-level work contract. [P2][P3]

**Lesson:** persist the user's objective and exact executor identity, then derive current panes/processes. Do not make “work exists” synonymous with “a pane is visible.” This can be adopted independently of Manager/Chief roles.

### 3.2 An idle agent is not necessarily a successful assignment

Herdsman observes Pi's `agent_before_settle` and `turn_end` outcomes, correlates them with the active request and response entry, and only returns success for a completed outcome with usable result text. Aborted, execution-error, and empty-result outcomes are distinct. [H6]

p3's `readHerdrTurn` currently returns latest assistant text and an `aborted` flag. Its watcher treats an idle/done worker as settled after seeing work or changed text; if it was not aborted, it marks the task completed. It does not separately expose a non-abort terminal model error in this path. [P4]

**Static consequence:** that path permits partial/previous assistant text plus a settled, errored worker to become a `completed` task. Whether a particular provider failure reaches that exact Herdr state still needs runtime reproduction. The source is sufficient to identify the missing success proof, not to claim an observed incident.

This is the most important learning because p3's dependency guard and workflows trust `completed`. A stronger workflow graph cannot compensate for an unreliable completion fact. A downstream task can otherwise receive “successful prerequisite” semantics without a successful model execution. [P5]

Herdsman fixed this class in its current release and includes a controlled terminal-error smoke scenario. That makes it especially relevant source material, not just a hypothetical design virtue. [H6][H15]

**Lesson:** model/run completion, assignment resolution, result delivery, and project acceptance are separate facts. Make successful execution an evidenced prerequisite, not an inference from silence.

### 3.3 Delivery is acknowledged by conversation evidence, not by calling `sendMessage`

Herdsman keeps durable pending result records. Direct-result cleanup checks exact delivered result identity in the owner's Pi history; submitting a message is not sufficient. Coordination inbox draining likewise retains a record if history does not yet prove delivery. Project messages survive Manager absence and are consumed once delivered to the Manager role. [H7][H8]

p3 has careful peer-message receipt states, cancellation handling, and next-prompt holding, but those receipts live in memory. Subagent completions use a different path: a completion slot is marked/persisted before `pi.sendMessage`. That is strong duplicate suppression, but it is not proof that the completion entered the conversation. [P6][P7]

The practical distinction is:

- p3's subagent claim-first path favors **at-most-one notification attempt**; a dropped queued message can leave a claim without a visible delivery.
- Herdsman's persistent pending/history-evidence path favors **recovery until delivery is proven**. Its project-message ADR explicitly admits one replay if a Manager is replaced in the unacknowledged interval. [H8]

Neither is an exactly-once transaction encompassing tools, messages, or external actions. For orchestration, a correlated recoverable duplicate is generally preferable to a permanently missing completion.

**Lesson:** preserve completion evidence until the recipient transcript proves receipt. Deduplicate by exact assignment/result identity rather than relying only on “we tried to send it.”

### 3.4 Results and source evidence are explicit transferable artifacts

Herdsman persists successful complete result text under its Pi data directory, provides readable references such as `result:researcher#1`, and carries hidden canonical bindings when those references are explicitly forwarded. The result artifact survives automatic worker/pane cleanup. [H9]

Its `files` field is a uniform handoff channel for delegation, continuation, questions, replies, steering, and peer/supervisor messages:

- canonicalize and deduplicate regular files;
- embed complete strict UTF-8 when permitted by payload limits;
- never partially embed a file;
- otherwise carry its canonical path/size;
- treat embedded text as a submission-time snapshot, but a reference-only file as live local evidence that may change or disappear;
- do not imply filesystem/tool permissions merely because a reference was attached. [H10]

p3's full worker result is cached in memory and omitted from telemetry/manifests. After restart, retrieval falls back to querying a live Herdr agent and reading its session. The persisted `sessionPath` is not used directly by that fallback. If the pane/agent has been removed, that is a weaker recovery path even though the Pi session may still exist on disk. The exposed result tool also caps its returned text at 12,000 characters; internal workflow RPC has a separate full-result path. [P3][P8]

**Important p3 exception:** its workflow engine already persists step outputs as `output.md` plus checksum/metadata files, verifies hashes before reuse, and references those artifacts from persisted runs. The missing durable result store is in ordinary routed-task/peer handoffs, not a claim that p3 never saves results. Workflow prompt handoffs still have a bounded insertion limit. `workflow-engine.ts:186–211,222–225,processTerminal` provide the corresponding evidence.

For ad-hoc research → plan → implementation handoffs, a uniform explicit result/evidence channel is more reliable than repeatedly rephrasing a long prior answer inside another task string. Within workflows, p3 already has a reusable artifact foundation.

**Lesson:** extend or reuse p3's existing artifact pattern for flat subagents rather than inventing a second storage system. Semantic names are useful ergonomics, not the essential correctness mechanism.

### 3.5 Authority and allowed actions are evidence-driven

Herdsman distinguishes `unknown` from `lost`. Missing/ambiguous identity does not authorize destruction; proven absent physical execution leaves a durable unresolved assignment. Its action projection includes `available_tools`, and mutations reacquire identity/ownership/lifecycle evidence. Closing a parent cascades child-first and preserves the parent if safe descendant cleanup cannot be proved. [H11]

Its health attention is event-driven with a 30-second fallback scan. Ten minutes without qualifying execution progress is advisory stale status, **not proof of a hang**. The initial stale event attempts a bounded diagnostic snapshot; later messages avoid re-reading merely to poll. [H11]

p3 has task states, abandoned detection, interruption handling, a task widget, and a 30-minute long-running advisory. These are useful but less expressive about assignment convergence and safe recovery actions. [P4]

Herdsman also distinguishes a cooperative correction (`steer_agent`) from cancelling and replacing the current operation (`interrupt_agent`) and from answering a correlated question (`reply_agent`). Its structured errors identify the operation, affected identities, rollback/retry facts, and a `nextAction`. p3 already has `steer` and Escape-based `stop`; the learnable improvement is their explicit assignment/lifecycle semantics, not merely adding a tool named steer. See `model-routing.ts:464–488` and Herdsman `agent-controller.ts:3568–3595`, `errors.ts:19–29`.

**Lesson:** distinguish “not visible,” “verified gone,” “waiting for a decision,” “failed execution,” and “result not yet delivered.” Surface currently valid controls and recovery facts rather than making the model reconstruct them from a generic state label. Copy the semantics, not necessarily every timer or state name.

## 4. Where p3 has capabilities worth retaining

### 4.1 Model routing is a different and valuable layer

Herdsman does not ignore models. Definitions can specify model/thinking; otherwise launch inherits controller settings, and saved-session continuation restores omitted settings. Its child-model resolver also handles extension-provided model discovery. [H12]

What it does not implement in this inspected orchestration layer is p3's task capability classification, conservative fallback classification, explicit-route preservation, shared provider cooldowns, and bounded cross-provider usage-exhaustion switch. Herdsman leaves model/provider capabilities to Pi and independent extensions; that is a deliberate composition philosophy, not necessarily an omission it should fix. [P9][H12]

The basic p3 failover was verified in committed HEAD. The existing dirty diff adds context-fit/compaction handling and is not counted as a released advantage or validated result.

**Keep:** task-sensitive routing and transparent fixed overrides. Do not replace this with a role roster and assume role names select the right capability tier.

### 4.2 Explicit dependency and workflow structure

p3 rejects `depends_on` if a prerequisite is absent or not completed. It rejects declared overlapping paths among active tasks with matching cwd in the primary's task registry. Its workflow layer separately expresses `needs`, hash-verified output artifacts, approval barriers, run persistence, and recovery. It is **sequential within a workflow**: `launchReady` selects `readyStepIds(run)[0]` and permits one live attempt. The DAG encodes prerequisite order, not concurrent step dispatch. Multiple ad-hoc subagents can still run in parallel. [P5]

Herdsman's ordinary coordination has parallel Agents and parent-child completion gates, but no equivalent declared assignment DAG in the inspected API. Its own open [#343](https://github.com/boadij/pi-herdsman/issues/343) requests persisted dependencies, fan-out, and joins. Independent-task ordering is currently predominantly behavioral guidance. [H13]

Do not overclaim p3's protection:

- `depends_on` validates launch; it does not by itself queue an entire graph.
- `owned_paths` is optional and local to the current registry/cwd comparison, not a filesystem lock or global multi-peer reservation.
- an agent can still edit undeclared paths;
- successful prerequisite checks inherit the completion-proof weakness described above.

**Keep, but strengthen the underlying outcome evidence:** p3 already has structure worth preserving. A more elaborate hierarchy is not a substitute for it.

### 4.3 Deliberate peer reachability

p3's peer messaging requires a launch relationship or a named connection established by the common primary/explicit user-directed interactive flow. Live terminal identities are checked; independent peer messages cross workspaces; disconnect revokes queued delivery eligibility. Urgency can be classified, but a currently executing tool is allowed to finish. [P2][P7]

Herdsman's Lead/Manager peer registry is user-global and same-role across repositories and Herdr sockets. It validates process generations but does not currently require p3-style named task connections or project-group eligibility. This is normal eligible-coordinator behavior, not an opt-in list of trusted task edges. [H14]

That makes collaboration discoverable, but also makes unrelated sessions reachable. Its open [#374](https://github.com/boadij/pi-herdsman/issues/374) seeks bounded peers for managed project Leads. The issue calls this an improvement request, not a recorded exploit or incident.

**Keep:** p3's task-scoped connection model if that matches the user's intended autonomy boundary. Broader discovery is not automatically better. Durable delivery and narrow reachability are independent choices; p3 can adopt the former without discarding the latter.

### 4.4 Bounded workers and directly usable peers

p3 deliberately excludes routed descendant delegation and has a four-active-foreground-task limit; background tasks are exempt. Independent worktree peers remain ordinary directly usable Pi sessions rather than project assignments that must be retired through Manager/takeover semantics. [P1][P2]

Herdsman's nested support can be useful for an implementer performing reconnaissance without returning the whole subtask to the Lead. However, nested execution adds another ownership edge, question/result handoff, and cleanup dependency. Its default nesting is bounded rather than unrestricted recursion. [H2]

Neither choice is universally superior. A flat model is easier to keep mentally local; nested work can reduce central-controller context. Actual outcome/token savings have not been measured here.

## 5. Costs, constraints, and things not to mistake for solved problems

### Optional hierarchy still has a real role cost

Herdsman's ordinary Flexible Lead does not require a bureaucracy. When using Manager mode, however, Manager cannot currently launch its own bounded Agents; Chief cannot either. Research/review support must be done through currently available tools or delegated through a Lead. Open [#371](https://github.com/boadij/pi-herdsman/issues/371) requests optional direct Agent delegation for these roles. [H1][H13]

Manager → Lead → Agent also introduces an additional conversation/coordination edge relative to a direct primary → worker. This is structural overhead, **not a measured token/cost penalty**. It earns its place when durable parallel branch work warrants that boundary; it need not be copied into every p3 task.

### Coordination authority is not write isolation

An exact ownership graph does not prevent two appropriately owned Agents from editing the same files. Fresh Herdsman Agents run in the delegating controller's cwd. Its non-overlap rule is primarily instruction-level. Separate project branches isolate Git working areas; nested Agents in one worktree do not gain separate checkouts. [H2][H13]

p3's declared path guard is stronger for that particular launch mistake, but still optional and not enforcement of filesystem writes. Neither panes nor worktrees are a security sandbox. Tool allowlists restrict Pi dispatch, not arbitrary OS activity enabled by an allowed `bash` or powerful extension.

### Context retirement trades continuity for fidelity

By default, Herdsman treats threshold compaction pressure in an active managed Agent as a retirement signal: persist the marker, cancel preventive compaction, ask the Agent to finish a self-contained handoff, and require a fresh Agent for follow-up. Manual compaction is exempt; actual overflow still uses native emergency recovery. [H16]

This is a thoughtful answer to losing exact working detail during summaries. It is also a behavioral policy: the model must converge while near its context limit. Cancelling threshold compaction does not provide additional context capacity or guarantee a clean handoff.

p3's Jev-assisted compaction instead retains selected tool evidence alongside Pi's normal summary. These optimize different failure modes. No comparative retention/quality measurements establish that retirement is better for every task. [P10]

### Durable does not mean transactional or runtime-independent

Herdsman's recoverable records live under Pi's agent data directory, which is a meaningful improvement over temporary-only state. But:

- supervision/project assignments are namespaced by a hash of the Herdr socket path, so controller turnover in the same runtime namespace is not the same claim as transparent recovery under an arbitrary replacement socket;
- mailbox writes use atomic rename but do not `fsync` the record/directory in that writer; p3's manifest writer also does not, so this is **not an asymmetric p3 advantage**;
- project-message delivery has an acknowledged replacement/replay interval;
- failed model execution does not automatically replay side-effecting tools or spawn a replacement executor;
- verified worktree absence retires the assignment rather than rebuilding the old managed assignment. Git branch/session history remain. [H5][H8][H17][P3]

These are boundaries to understand, not reasons to dismiss the durable design.

### More observability is not the same as cheaper operation

Herdsman aggregates Pi-native usage for proven owned session trees and, for an active Manager, current assigned Leads plus their trees. It explicitly marks incomplete coverage rather than pretending unresolved sessions cost zero. This is worth borrowing. [H18]

Its controller prompts currently include complete definition metadata such as tools, extensions, and model settings. Open [#367](https://github.com/boadij/pi-herdsman/issues/367) seeks lean on-demand discovery; potential savings have not been measured. Coordination tools remain present even in `tools: []` coordination profiles. [H3][H13]

The implementation is substantial: approximately 7,800 lines in `agent-controller.ts`, 11,200 in `lead-runtime.ts`, and thousands more in presentation/supervision/runtime modules at this snapshot, excluding tests. Line count is formatting-sensitive and does not prove bad design or slowness. It does show that adopting the control plane brings a meaningful maintenance surface, not a few launch helpers.

### Validation maturity and its limits

Herdsman has a focused distribution surface, extensive test definitions, package auditing, documented runtime baselines, and Linux/macOS/Windows Node-check CI. The inspected main commit's Validate run [38247496303](https://github.com/boadij/pi-herdsman/actions/runs/38247496303) succeeded upstream. This does not establish full live Windows Herdr support or complete runtime acceptance. [H15]

Its especially useful testing idea is **a fake provider controlling model choices while real Pi, Herdsman, and Herdr perform the actual cross-process work**. Faux rules require correlated successful real tool results and delivered child messages; the harness verifies persisted evidence and cleans up its exact isolated resources. [H15]

Four simulated scenarios exist, but current default CI does not run them; [#381](https://github.com/boadij/pi-herdsman/issues/381) identifies that gap. Manager recovery remains live-only. A green unit/build pipeline is not the same proof as passing these process-boundary scenarios.

p3 also has targeted routing/workflow/peer tests and a script with typechecks and extension tests. This local checkout has no GitHub workflow files, and the public repository's queried run list was empty. No claim is made that either suite passed locally during this research. [P11]

## 6. What is worth borrowing, in order

These are recommendations, not implementation changes or new agreed scope.

| Priority | Idea | Why | Small p3-shaped version |
|---|---|---|---|
| **1 — correctness prerequisite** | Correlated execution outcome | False success invalidates dependency/workflow reasoning | Require successful Pi execution evidence for completion; preserve failed/aborted/empty-result distinctions |
| **2 — reliability** | Durable complete results + delivery proof | Preserve ordinary subagent results across pane cleanup/reload; avoid permanently claimed-but-undelivered completion | Reuse the existing workflow artifact pattern with assignment identity; retain pending completion until recipient history proves delivery |
| **3 — better handoffs** | Explicit evidence inputs | Avoid lossy repeated prompt summaries and ambiguous artifact forwarding | Forward existing result/file artifacts explicitly; distinguish embedded snapshot from live path reference |
| **4 — capability clarity** | Actually read-only worker profiles | “Please don't edit” is weaker than removing write/bash tools | A narrowly scoped read-only launch capability; no need to copy a whole roster framework |
| **5 — recovery usability** | State-specific actions and bounded health evidence | Better response to missing/stale/blocked work without polling or guessing | Expose safe controls, rollback/retry facts and next action; distinguish disappearance from ambiguity and pending delivery |
| **6 — only if needed** | Durable branch-work record | Gives independent worktree work continuity across primary turnover | Persist objective, repo/branch, exact executor/session, open/paused state; derive live placement from Herdr |
| **7 — development leverage** | Deterministic real-runtime smoke | Covers extension scheduling and process boundaries without paying an LLM for each test | Isolated fake-provider scenario with real Pi/Herdr, transcript assertions, and exact-ID cleanup |
| **8 — visibility** | Coverage-aware usage aggregation | Know whether a reported total actually covers all assigned work | Retain p3 model/cost widgets; explicitly label missing coverage before expanding to peer trees |

Interesting but not automatic recommendations:

- **One bounded nested level:** potentially useful for reconnaissance inside implementation, but only when it demonstrably reduces primary coordination/context.
- **Context retirement:** worth experimenting against p3's compaction strategy on long, evidence-sensitive tasks; not established as superior.
- **Operation-specific tools:** Herdsman's ADR records real provider/schema problems with multiplexed APIs. Its fix is narrow schemas per operation. p3's `subagent_control` also multiplexes actions, but no matching defect was established here; treat this as a lesson if such errors recur, not a reason to split tools preemptively. [H19]
- **Discoverable definition/configuration UI and docs:** useful if p3 becomes a public orchestration product rather than Paul's extension collection. Not necessary to imitate its whole vocabulary.

## 7. What I would not copy just because it exists

1. **Chief/Manager role taxonomy as a prerequisite for durability.** Persist work identity and outcomes first; introduce supervision roles only when their scope boundaries solve an actual need.
2. **User-global peer reachability.** It conflicts with p3's more deliberately bounded coordination contract, and upstream is itself considering project-group restrictions.
3. **An extensive configuration/definition inheritance engine before needing specialist policy.** Start from the missing capability, such as genuinely read-only workers, rather than the whole framework.
4. **Automatic replacement or side-effect retries.** Herdsman itself conservatively avoids them. A process failure does not prove a previous tool had no external effect.
5. **Every lifecycle timer/state as-is.** Borrow distinctions with demonstrated value; keep p3's human-facing model understandable.
6. **Claims of speed, quality, or cost superiority from feature lists.** A fair experiment would hold the task, model/effort, provider, runtime, repository revision, and acceptance evidence constant and count coordination turns as well as coding turns.

## 8. Workload-specific answer to “is it better?”

- **One session, a few bounded helpers, explicit model selection, and direct human use of peer worktrees:** p3 remains a credible fit. Herdsman is not a clear overall improvement just because it offers more supervisory roles.
- **Several independent branches, pause/resume, a Manager going away, pending results, and continued managed execution:** Herdsman is materially better equipped today.
- **A persisted research/plan/implementation/validation flow with approval barriers:** p3 has stronger explicit workflow structure; its completion fact needs to be hardened before treating that as end-to-end reliability.
- **Read-only scouting/review with real tool restrictions and explicit evidence artifacts:** Herdsman has the stronger ready-made contract.
- **Budget/usage-sensitive dispatch across configured providers:** p3 has the more specific built-in policy; not evidence that it is cheaper on an identical task.
- **Reducing accidental unrelated-agent chatter:** p3's scoped connection design is narrower; Herdsman's same-role global pool is a different policy, not proof of abuse or insecure transport.

The strongest generalizable design sentence from Herdsman is:

> **The work is durable, the executor is exact and replaceable, and placement is current evidence—not authority.**

p3 can learn that lesson without giving up manual decisions, visible panes, project-derived worktrees, or its simpler primary/worker/peer vocabulary.

## Primary-source index

Herdsman links are pinned to the inspected commit. p3 references point to local files in this checkout; line ranges in prose describe the inspected snapshot.

[H1]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/concepts/coordination.md
[H2]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/concepts/delegation.md
[H3]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/agent-definitions.ts#L586-L656
[H4]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/lead-runtime.ts#L6530-L6703
[H5]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/supervision.ts#L1648-L1814
[H6]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/managed-agent-runtime.ts#L1372-L1398
[H7]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/agent-controller.ts#L4918-L4938
[H8]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/adr/0016-consume-project-messages-after-manager-delivery.md
[H9]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/agent-controller.ts#L5152-L5249
[H10]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/guides/handoffs.md
[H11]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/guides/recovery.md
[H12]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/agent-definitions.ts#L761-L808
[H13]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/reference/agent.md
[H14]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/reference/peer.md
[H15]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/development/smoke-testing.md
[H16]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/managed-agent-runtime.ts#L2610-L2663
[H17]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/adr/0019-retire-project-assignments-when-worktrees-are-absent.md
[H18]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/presentation.ts#L165-L257
[H19]: https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/docs/adr/0006-use-operation-specific-semantic-tools.md
[P1]: ../../extensions/routing/launch.ts
[P2]: ../../extensions/routing/independent.ts
[P3]: ../../extensions/routing/manifest.ts
[P4]: ../../extensions/routing/herdr.ts
[P5]: ../../extensions/routing/workflow.ts
[P6]: ../../extensions/model-routing.ts
[P7]: ../../extensions/routing/peer-links.ts
[P8]: ../../extensions/routing/state.ts
[P9]: ../../extensions/routing/policy.ts
[P10]: ../../extensions/jev-compaction.ts
[P11]: ../../scripts/test-extensions.sh

Additional implementation anchors:

- Herdsman verified completed/error result construction: [`managed-agent-runtime.ts:1542–1600`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/managed-agent-runtime.ts#L1542-L1600).
- Herdsman pending inbox delivery/history acknowledgement: [`supervision.ts:876–955`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/supervision.ts#L876-L955).
- Herdsman socket-scoped supervision root: [`supervision.ts:987–1005`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/supervision.ts#L987-L1005).
- Herdsman atomic mailbox writer: [`mailbox.ts:721–742`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/mailbox.ts#L721-L742).
- Herdsman default configuration: [`config.ts:35–43`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/config.ts#L35-L43).
- Herdsman actual global-peer tool/presence policy: [`index.ts:332–354`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/index.ts#L332-L354), [`lead-runtime.ts:7797–7848`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/lead-runtime.ts#L7797-L7848).
- Herdsman read-only profiles: [`scout.md`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/agent-definitions/scout.md), [`reviewer.md`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/extension/agent-definitions/reviewer.md).
- Herdsman faux provider's correlated-result requirement: [`smoke-faux.mjs:29–103`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/scripts/smoke-faux.mjs#L29-L103).
- Herdsman current CI jobs: [`validate.yml`](https://github.com/boadij/pi-herdsman/blob/897810003200ed68475e0aac2cb8cf09d4f5ea91/.github/workflows/validate.yml).
- p3 local anchors: `herdr.ts:281–301,352–395` (completion inference); `model-routing.ts:268–300` (notification claims), `428–449` (result recovery), `789–857` (task restoration); `workflow.ts:45–62` (narrow prerequisites/owned-path guard); `launch.ts:93–105` (four-foreground-task limit); `peer-links.ts:69–83` (reachability/live identity); `independent.ts:73–150` (receipts/abort), `204–250` (worktree agent launch).
- p3 workflow layer: [`workflow-engine.ts`](../../extensions/workflow-engine.ts), [`scheduler.ts`](../../extensions/workflows/scheduler.ts), [`rpiv.yaml`](../../workflows/rpiv.yaml).
