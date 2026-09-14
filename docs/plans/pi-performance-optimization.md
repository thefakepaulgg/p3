# Pi startup and memory optimization plan

**Status:** Phases 1–5 implemented locally; upstream publication and installation pending  
**Measured against:** Pi 0.85.1, `p3` 0.1.0, `pi-mcp-adapter` 2.33.0, `pi-hermes-memory` 0.9.4, `pi-agent-browser-native` 0.2.61  
**Primary goal:** Keep the current programmable Pi experience while reducing startup latency and per-agent memory enough that a Rust rewrite is unnecessary.

## Outcome

Implement the work in this order:

1. Add a repeatable startup and memory benchmark.
2. Lazy-load the MCP SDK used by `p3`'s Claude Connectors extension.
3. Give routed Herdr workers a lean extension profile.
4. Upstream a thin, lazy bootstrap for Hermes Memory.
5. Upstream a thin, lazy bootstrap for the MCP adapter.
6. Re-measure, then investigate the browser extension or Pi's loader only if the targets are still missed.

Preserve the root Pi session's behavior. Optimize imports and worker composition rather than removing `p3` features.

## Local implementation results

The `p3` changes are in this repository. Upstream package changes are staged separately in:

- `/Users/agent/workspace/pi-hermes-memory` (based on v0.9.9);
- `/Users/agent/workspace/pi-mcp-adapter` (based on v2.33.0-era `main`).

No package was published or installed into the active Pi configuration during benchmarking.

The final matched harness copied the actual root Hermes and MCP configuration. The optimized copy differed by exactly one setting: `lazyInitialization: true`.

| Scenario | Installed packages | Optimized local sources |
|---|---:|---:|
| Warm root, 3-run mean | 573 ms / 197 MiB | **292 ms / 126 MiB** |
| Forced cold Jiti cache | 1,828 ms / 443 MiB | **1,015 ms / 378 MiB** |
| Resume copied 0.8 MiB session | 587 ms / 197 MiB | **298 ms / 126 MiB** |
| Resume copied 40.5 MiB session | 640 ms / 198 MiB | **319 ms / 126 MiB** |

An earlier unmatched optimized run of that 40.5 MiB fixture measured 358 ms and 224 MiB; the matched rerun above did not reproduce the elevated footprint. Both observations are retained rather than discarding the outlier.

| Routed-worker configuration | Ready time | Physical footprint |
|---|---:|---:|
| Default lean routed worker | 181 ms | 94 MiB |
| Four concurrent lean workers | 287 ms mean | 95.6 MiB maximum each |

Claude Connectors contributes 0–1 ms after its MCP SDK was deferred. Optimized warm imports measured approximately 66–69 ms for Hermes and 22–40 ms for the MCP adapter, depending on the surrounding configuration.

Deferred first-use validation called the real `memory_search` tool and the read-only remote `claude-design_list_projects` MCP tool. Hermes first use took 616 ms and raised the process physical footprint from a 93 MiB idle process to 181 MiB. The MCP remote call took 2.19 seconds including connection/auth/network work and raised physical footprint from 104 MiB idle to 155 MiB. A bare post-model control process measured 104 MiB, so these post-use values include approximately 10 MiB of ordinary model-turn overhead. The same MCP remote call succeeded from an extracted npm tarball in 1.76 seconds, and `memory_search` succeeded from an extracted Hermes tarball in 967 ms.

Hermes retains its documented `lazyInitialization: false` default. The active user configuration was not changed by these benchmarks. Release-gate probes also cover never-settling imports: shutdown and session replacement release obsolete event/context references, late imports are fenced, eligible shutdown flushes still run once, and both lazy and eager replacement sessions initialize independently.

## Evidence

### Warm startup

“Ready” means the child terminal entered raw mode and could accept interactive input. Runs were sequential to avoid CPU contention.

| Configuration | Ready time | RSS | macOS physical footprint |
|---|---:|---:|---:|
| Minimal Pi | 193 ms mean | 143 MiB | 91 MiB |
| Normal resources, extensions disabled | 203 ms mean | 149 MiB | not measured |
| Full configured Pi | 682 ms mean | 316 MiB | 273 MiB |
| Full suite except MCP adapter and Hermes | approximately 315 ms | 182 MiB | 131 MiB |

Five-run spread:

- Minimal ready time: 157–208 ms, 20 ms standard deviation.
- Resources without extensions: 199–210 ms, 5 ms standard deviation.
- Full configured Pi: 652–729 ms, 29 ms standard deviation.
- Full configured Pi RSS: 315–317 MiB.

### Extension import timing

Pi's built-in `PI_TIMING=1` instrumentation attributes almost all startup work to module imports. Three warm full-start runs produced:

| Extension | Mean module import | Share of extension loading |
|---|---:|---:|
| `pi-hermes-memory` | 270 ms | 55% |
| `pi-mcp-adapter` | 113 ms | 23% |
| `p3/extensions/claude-connectors.ts` | 43 ms | 9% |
| `pi-agent-browser-native` | 24 ms | 5% |
| Everything else | approximately 38 ms | 8% |

The four named imports account for approximately 92% of warm extension loading. Extension factories took 0–4 ms. Measured `session_start` work was approximately 30 ms for Hermes, 2 ms for the MCP adapter, and less than 1 ms for the browser and Claude Connectors. The delay is therefore primarily module loading and evaluation, not `p3` orchestration or lifecycle work.

### Cold Jiti cache

`JITI_REBUILD_FS_CACHE=1` simulated a cold transform cache:

- Ready time: 1.90 seconds.
- RSS: 499 MiB.
- Physical footprint: 468 MiB.
- MCP adapter import: 636 ms.
- Hermes import: 580 ms.
- Total extension loading: 1.72 seconds.

The warm cache lives under `/tmp/jiti`. Package updates or cache loss can therefore make the first new Pi process much slower and heavier than later starts.

### Memory attribution

Warm full physical footprint was 273 MiB. Leave-one-out measurements were:

| Removed extension | Remaining physical footprint | Observed reduction |
|---|---:|---:|
| MCP adapter | 140 MiB | 133 MiB |
| Claude Connectors | 205 MiB | 68 MiB |
| Hermes | 214 MiB | 59 MiB |
| Browser | 217 MiB | 56 MiB |

These reductions are **not additive**. Their sum exceeds the entire extension-attributable footprint because the extensions share dependency/runtime costs and cause different V8 heap growth. Treat each leave-one-out reduction as an upper bound, not an independent memory budget.

The MCP adapter is the dominant idle-memory contributor. Hermes is the dominant warm-start contributor. Most of `p3`—routing, workflows, tasks, Tutor Mode, advisor, model style, and notifications—is comparatively cheap. Claude Connectors is the one meaningful `p3` contributor because it imports the MCP SDK at module load.

### Sessions, network, and concurrent agents

- Online startup was close to offline startup in this sample; network startup was not a leading cost.
- Resuming a copied 0.8 MiB session reached raw mode in approximately 690 ms, close to a new full session. Rendering the transcript caused a transient physical peak around 320 MiB, then settled around 278 MiB.
- Four live Pi processes occupied about 808 MiB summed physical footprint. That sum still overcounts shared mappings, but it confirms that worker count multiplies the private extension/runtime cost.
- The measured machine had no memory pressure. The optimization matters most on smaller hosts and during concurrent Herdr work.

## Success criteria

All criteria apply without removing root-session capabilities.

### Root session

- Warm ready time is at most 400 ms on the measurement machine.
- Cold-cache ready time is at most 1 second.
- Warm idle physical footprint is at most 180 MiB.
- Existing `p3` extension tests pass.
- Claude Connectors, MCP tools, memory/search, browser, LSP, routing, workflow, Tutor Mode, tasks, advisor, and notifications remain available.

### Routed workers

- Default routed workers reach interactive-ready within 300 ms on the measurement machine.
- A default routed worker has at most 130 MiB physical footprint before its first model turn.
- A worker receives only the extensions required by its task contract.
- Herdr lifecycle reporting and result delivery continue to work.

### Deferred work

Startup improvements must not merely hide an unacceptable first-use pause.

- Record first-use latency for Claude Connectors, memory search, MCP search/call, and browser startup.
- A deferred import reports ordinary tool progress rather than appearing hung.
- Concurrent first calls share one loader promise instead of importing the same module graph repeatedly.
- Import failures clear or replace the cached promise so a recoverable failure does not poison the process permanently.

## Phase 1: Check in the benchmark

Create `scripts/profile-pi-startup.py` using only the Python standard library.

### Behavior

1. Open a pseudo-terminal.
2. Launch the requested Pi command in a new process group.
3. Set `PI_OFFLINE=1` by default.
4. Remove `HERDR_*` and `MOSHI_*` variables from the child environment so probes cannot report lifecycle state against the parent pane.
5. Poll terminal attributes until canonical mode is disabled. Record that point as `ready_ms`.
6. Sample root and descendant RSS while the process is alive.
7. Optionally hold the process after readiness to catch delayed child startup.
8. Send `/quit` only after readiness.
9. Terminate the process group on timeout.
10. Emit one JSON object containing exit status, ready time, elapsed time, root RSS, process-tree RSS, maximum process count, and timeout state.

Add a small shell driver, `scripts/profile-pi-configurations.sh`, for sequential repeated runs. It should cover:

- minimal Pi;
- normal resources with extensions disabled;
- full configured Pi;
- `p3` only;
- third-party extensions only;
- full minus one named extension;
- full with `JITI_REBUILD_FS_CACHE=1`;
- full resuming a copied session fixture.

On macOS, optionally run `vmmap -summary` after readiness and report `Physical footprint`. RSS and physical footprint must remain separate fields.

Enable `PI_TIMING=1` and retain only timing lines in benchmark artifacts. Raw terminal output can contain session content and must not be committed.

### Benchmark discipline

- Run timing samples sequentially. Parallel probes distorted import times during diagnosis.
- Use at least five warm runs for headline numbers.
- Report mean, standard deviation, and range.
- Use a copied session file for resume measurements.
- Keep cold-cache and warm-cache results separate.
- Never sum leave-one-out memory reductions.

### Completion criterion

A single documented command reproduces the baseline table and exits without changing Pi settings, session history, Herdr state, or Moshi state.

## Phase 2: Lazy-load Claude Connectors' MCP runtime

File: `extensions/claude-connectors.ts`

The extension currently imports these runtime classes at module evaluation:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

Replace the runtime imports with type-only imports and a cached dynamic loader. The intended shape is:

```ts
type McpRuntime = {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StreamableHTTPClientTransport:
    typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
};

let mcpRuntimePromise: Promise<McpRuntime> | undefined;

function loadMcpRuntime(): Promise<McpRuntime> {
  // Import both modules once and return their constructors.
}
```

Call `loadMcpRuntime()` inside `withClient`, immediately before constructing the transport and client. Catalog-only actions such as `list_connectors` should not load the SDK because they use ordinary HTTP rather than MCP.

Use one shared promise so simultaneous calls coalesce. If loading fails, clear the promise before rethrowing so a later retry can succeed.

### Verification

- Run `./scripts/test-extensions.sh`.
- Verify `list_connectors` without loading the MCP client modules.
- Verify `list_tools`, `describe_tool`, and `call` still connect and close the client.
- Verify abort propagation and credential-origin checks remain unchanged.
- Re-run the isolated extension benchmark.

### Completion criterion

Before first MCP-backed connector use, Claude Connectors adds no more than 5 ms to warm extension import time. Its first MCP-backed call succeeds and pays the deferred import cost exactly once.

## Phase 3: Launch routed workers with a lean extension profile

Files:

- `extensions/routing/herdr.ts`
- `extensions/routing/launch.ts`
- corresponding tests under `extensions/routing/`

The root session needs the complete extension suite. A routed helper generally does not need root-only orchestration, widgets, notifications, Tutor Mode, Claude connectors, browser control, the full MCP UI, or background memory maintenance. Today `launchHerdrAgent` starts ordinary Pi and therefore inherits global extension discovery.

### Inventory before changing launch arguments

For representative planning, implementation, and review workers, record which extension tools they actually call. Classify each extension as:

- required for every worker;
- required only for an explicit task capability;
- root-only.

At minimum, preserve the managed Herdr state extension so `interactive_ready`, working, blocked, idle, and session reporting remain correct. Preserve model-style behavior only if worker output depends on it. Cheap LSP or web-search extensions can remain when evidence shows they are routinely used.

### Launch change

Build worker Pi arguments in one tested function rather than assembling them inline. The default worker invocation should include `--no-extensions` followed by explicit `-e` entries for the required worker set. Continue passing model, thinking level, and session name exactly as today.

Resolve extension paths from stable roots rather than embedding the current username:

- `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`;
- the current `p3` package directory via `import.meta.url`;
- installed package roots through Pi-supported package references or resolved package locations.

Keep the public `routed_task` input unchanged for the first implementation. Introduce a task capability/profile parameter only if the inventory proves that one default worker set cannot serve the existing task classes.

### Verification

- Unit-test the exact Herdr `agent start` argument vector.
- Verify `--no-extensions` is followed by the required explicit entries.
- Verify the root model-routing extension is not recursively loaded into helpers.
- Launch one planning, implementation, and review worker.
- Confirm prompt submission, lifecycle readiness, blocking, completion wake-up, result retrieval, and pane retention.
- Compare worker tool inventories before and after; every removed tool must be intentionally classified as root-only or capability-specific.
- Measure one worker and four concurrent workers.

### Completion criterion

Default workers meet the routed-worker performance targets while all routing lifecycle tests and representative end-to-end tasks pass.

## Phase 4: Make Hermes Memory's entrypoint thin

Target upstream package: `pi-hermes-memory`.

Hermes ships 52 TypeScript files and no compiled JavaScript. Its entrypoint imports stores, database code, session indexing, consolidation, correction detection, commands, and tools eagerly. The extension factory itself is cheap; module import dominates.

### Partition the dependency graph

Keep only capabilities required before the first prompt in the eager path:

- configuration and project detection;
- loading standing instructions and the memory needed to build prompt context;
- minimal store/database handles required by immediately visible tools;
- lightweight tool and command registration.

Move these behind cached dynamic loaders where behavior permits:

- session backfill and explicit session indexing;
- consolidation;
- insights/interview/switch-project/index commands;
- correction detection and background review implementation;
- session search implementation;
- migration helpers after the migration sentinel proves no migration is pending.

Tools and commands still need their names, descriptions, and schemas at startup. Register thin handlers eagerly and load the implementation on first execution. Background work can start after the interactive session is ready, but memory required for the first system prompt must remain awaited.

### Migration safety

Do not defer a migration past the first database operation that depends on it. Encode that invariant in one `ensurePersistenceReady()` promise shared by every database-backed path. Concurrent callers await the same operation. Shutdown waits for started background work using the package's existing bounded shutdown behavior.

### Verification

- Run the Hermes package's own checks and tests.
- Test first session after installation or migration separately from steady state.
- Test normal startup with no pending migration.
- Test `memory_search`, `session_search`, writes, consolidation, correction detection, background review, and session shutdown.
- Measure warm import, cold import, first prompt preparation, and first invocation of every deferred branch.

### Completion criterion

Hermes contributes at most 50 ms to a normal warm startup and at most 200 ms to a cold-cache startup. First-prompt memory and all persistence invariants remain unchanged.

## Phase 5: Make the MCP adapter's entrypoint thin

Target upstream package: `pi-mcp-adapter`.

The adapter's `index.ts` imports approximately 70 reachable local modules and over 1 MiB of top-level TypeScript source. It eagerly reaches configuration, commands, OAuth, UI/app bridges, schema validation, code mode, tool rendering, server management, and installation flows. Its factory and measured session handler are cheap; loading that graph is the cost.

### Keep eager

- MCP configuration discovery required to know which tools/prompts exist.
- cached metadata required to register model-visible proxy/namespace tools;
- minimal status state and thin tool schemas;
- lifecycle ownership and shutdown handles.

### Defer

Create cached loaders around independent feature branches:

- OAuth and callback server;
- MCP Apps/UI resource handling and app bridge;
- interactive setup and management panels;
- code-mode worker;
- JSON Schema/AJV validators until validation is required;
- installation and package/plugin discovery commands;
- detailed renderers until an MCP result is rendered;
- transports/server-manager implementation until the first connection.

Keep direct tools and namespace proxy tools registered at startup, but have their execution handlers call `ensureMcpRuntime()`.

Avoid one giant dynamic import. Split by feature boundary so calling an ordinary MCP tool does not pull in OAuth UI, app rendering, setup panels, and code mode.

### Verification

- Run the adapter's typecheck and focused tests.
- Test cached-metadata startup with no server connection.
- Test stdio and HTTP connection, OAuth, direct tools, namespace tools, prompts/resources, sampling, elicitation, code mode, UI sessions, reconnect, and shutdown.
- Verify concurrent first calls coalesce initialization.
- Measure warm/cold startup and first-use latency for each feature branch.

### Completion criterion

The adapter contributes at most 40 MiB physical footprint and 50 ms warm import time before first MCP use. Core MCP calls remain available and deferred branches initialize only when selected.

## Phase 6: Reassess the browser extension

Target upstream package: `pi-agent-browser-native`.

The browser extension is already distributed as JavaScript and adds only about 24 ms import time, so it follows Hermes and MCP work. Its leave-one-out memory reduction was large but non-additive, making the number unsuitable as a standalone budget.

If the root target remains unmet after Phases 2–5:

1. Use Pi timing and a heap/CPU profile to separate the entrypoint's 92-module evaluation from shared dependency effects.
2. Keep tool schema, policy, and session restoration eager.
3. Defer Electron host support, source lookup, network diagnostics, screenshot/result processing, and other input-mode implementations until the selected mode requires them.
4. Measure ordinary browser calls and Electron calls separately.

### Completion criterion

Either the root targets already pass and this phase is skipped, or the browser entrypoint is reduced without slowing its common first call beyond the agreed first-use budget.

## Phase 7: Consider Pi loader changes only with remaining evidence

Pi creates Jiti with filesystem caching enabled and `moduleCache: false`. A shared aggregator extension did not improve startup or memory, so simply merging extension entrypoints is not a solution.

If package-level laziness still misses the targets, investigate upstream Pi changes with isolated benchmarks:

- one loader/cache generation shared across extension imports;
- module-cache semantics that preserve `/reload` correctness;
- releasing transformed module graphs after initialization when handlers no longer require them;
- a supported precompiled-extension path that still resolves Pi's virtual SDK modules without loading duplicate copies.

Any loader proposal must test `/reload`, extension isolation, tool/command ownership, stale handlers, package aliases, and virtual modules. Keep it out of `p3` unless Pi exposes a supported configuration.

### Completion criterion

A Pi loader change is pursued only when a reproducible benchmark shows a remaining loader cost that package-level changes cannot remove.

## Approaches ruled out by measurement

Do not repeat these without new evidence:

- **Rust rewrite first:** the current extension graph adds roughly twice the minimal host's physical footprint. Rewriting only the host leaves the dominant work untouched.
- **Run Pi under Bun:** the installed Pi bundle exits under Bun 1.3.14 because bundled Undici expects `webidl.util.markAsUncloneable`.
- **Force garbage collection:** forced GC reduced reported live heap but did not return RSS or physical footprint during the measurement window.
- **Merge all extensions into one aggregator:** startup and RSS remained effectively unchanged.
- **Naively bundle Hermes:** a single Bun-generated bundle imported slower and used substantially more memory.
- **Naively transpile Hermes to JavaScript:** import time improved only slightly while physical footprint grew because native resolution loaded dependency copies outside Pi's Jiti virtual-module path.
- **Blame network startup:** online and offline readiness were close.
- **Blame session history first:** the copied 0.8 MiB session changed transient rendering cost, not the dominant startup path.

## Delivery sequence

Use separate changes so every performance claim remains attributable:

1. Benchmark harness and baseline documentation.
2. Claude Connectors lazy import.
3. Lean Herdr worker launch.
4. Hermes upstream change.
5. MCP adapter upstream change.
6. Browser or Pi loader work only if required.
7. Final before/after report covering warm root, cold root, resumed root, one worker, and four concurrent workers.

After each change, run the same benchmark matrix and record the commit, package versions, mean, spread, RSS, physical footprint, and first-use cost. Revert a change that only shifts latency into common tool use without reducing peak memory or total task latency.

## Final decision gate

Revisit a compiled replacement only after Phases 1–5. A Rust or Go rewrite becomes justified if the optimized extension suite still cannot meet the root and worker targets, or if profiling shows Node's minimal 91 MiB physical baseline—not extension loading—is the remaining deployment blocker.
