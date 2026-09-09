import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_ENTRY = "tutor-mode-state";
const PROGRESS_PATH = ".pi/tutor-progress.md";
const PROGRESS_TOOL = "tutor_progress";
const BUILD_TOOL = "tutor_xcode_build";

const ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "lsp_diagnostics",
  "web_search",
  "memory_search",
  "session_search",
  "task_list",
  PROGRESS_TOOL,
  BUILD_TOOL,
]);

const TUTOR_PROMPT = `
## Tutor Mode — active

You are a tutor, not an implementer. The learner must do the work.

Hard boundaries:
- Do not modify source files, configuration, tests, Git state, or external systems.
- The only writable repository file is .pi/tutor-progress.md, through tutor_progress.
- Do not delegate implementation.
- Do not provide complete patches, finished implementations, or code that can simply be pasted to solve the current exercise. If the learner asks for the solution, explain that they must explicitly run /tutor off first.

Teaching method:
- Ground lessons in the current codebase and the learner's stated goal.
- Ask the learner to predict behavior or explain their model before revealing an explanation.
- Give one appropriately sized task at a time.
- Use a hint ladder: concept first, then relevant file or symbol, then pseudocode only if needed.
- Review the learner's diff and reasoning. Identify problems without rewriting the solution.
- Prefer retrieval, tracing, debugging, and small real changes over lectures.
- Record concise evidence of demonstrated concepts, misconceptions, and review needs in .pi/tutor-progress.md. Do not record mere task completion as mastery.
`;

interface TutorModeState {
  enabled: boolean;
  toolsBeforeTutorMode?: string[];
}

const ProgressParams = Type.Object({
  action: StringEnum(["read", "append"] as const),
  content: Type.Optional(Type.String({ minLength: 1, description: "Markdown to append when action is append" })),
});

const BuildParams = Type.Object({
  scheme: Type.String({ minLength: 1, description: "Existing Xcode scheme to build" }),
  destination: Type.Optional(Type.String({ minLength: 1, description: "xcodebuild destination specifier" })),
});

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function progressFile(cwd: string): string {
  return join(cwd, PROGRESS_PATH);
}

async function ensureProgressFile(cwd: string): Promise<void> {
  const path = progressFile(cwd);
  try {
    await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "# Tutor Progress\n\n", "utf8");
  }
}

export default function tutorModeExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let toolsBeforeTutorMode: string[] | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "tutor-mode",
      enabled ? ctx.ui.theme.fg("warning", "◉ tutor") : undefined,
    );
  }

  function applyTutorTools(): void {
    if (toolsBeforeTutorMode === undefined) toolsBeforeTutorMode = pi.getActiveTools();
    pi.setActiveTools(unique([
      ...toolsBeforeTutorMode.filter((name) => ALLOWED_TOOLS.has(name)),
      PROGRESS_TOOL,
      BUILD_TOOL,
    ]));
  }

  function restoreTools(): void {
    if (toolsBeforeTutorMode) pi.setActiveTools(toolsBeforeTutorMode);
    toolsBeforeTutorMode = undefined;
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY, {
      enabled,
      toolsBeforeTutorMode,
    } satisfies TutorModeState);
  }

  async function setEnabled(next: boolean, ctx: ExtensionContext): Promise<void> {
    if (next === enabled) {
      if (ctx.hasUI) ctx.ui.notify(`Tutor mode is already ${enabled ? "on" : "off"}.`, "info");
      return;
    }

    enabled = next;
    if (enabled) {
      await ensureProgressFile(ctx.cwd);
      applyTutorTools();
      if (ctx.hasUI) ctx.ui.notify(`Tutor mode enabled. Source is read-only; ${PROGRESS_PATH} is writable.`, "info");
    } else {
      restoreTools();
      if (ctx.hasUI) ctx.ui.notify("Tutor mode disabled. Full tool access restored.", "info");
    }
    updateStatus(ctx);
    persistState();
  }

  pi.registerTool({
    name: PROGRESS_TOOL,
    label: "Tutor Progress",
    description: `Read or append learning evidence to ${PROGRESS_PATH}. This is the only repository file Tutor Mode may modify.`,
    promptSnippet: "Read or append evidence to the Tutor Mode learning notebook",
    promptGuidelines: [
      "In Tutor Mode, append only demonstrated understanding, misconceptions, and concepts that need review; task completion alone is not mastery.",
    ],
    parameters: ProgressParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!enabled) {
        return {
          content: [{ type: "text", text: "Tutor mode is off. Use /tutor on first." }],
          isError: true,
        };
      }

      await ensureProgressFile(ctx.cwd);
      const path = progressFile(ctx.cwd);
      if (params.action === "read") {
        const content = await readFile(path, "utf8");
        return { content: [{ type: "text", text: content }] };
      }

      const content = params.content?.trim();
      if (!content) {
        return {
          content: [{ type: "text", text: "content is required for append" }],
          isError: true,
        };
      }
      await appendFile(path, `${content}\n\n`, "utf8");
      return { content: [{ type: "text", text: `Appended learning evidence to ${PROGRESS_PATH}` }] };
    },
  });

  pi.registerTool({
    name: BUILD_TOOL,
    label: "Tutor Xcode Build",
    description: "Build an existing Xcode scheme without exposing an arbitrary shell. Derived data is written outside the repository and automatic package resolution is disabled.",
    promptSnippet: "Compile an existing Xcode scheme while Tutor Mode keeps source read-only",
    promptGuidelines: ["Use only to check learner-written code; do not treat a successful build as proof of understanding."],
    parameters: BuildParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!enabled) {
        return {
          content: [{ type: "text", text: "Tutor mode is off. Use the normal build tools." }],
          isError: true,
        };
      }

      if (params.scheme.startsWith("-") || params.destination?.startsWith("-")) {
        return {
          content: [{ type: "text", text: "Scheme and destination must not begin with '-'." }],
          isError: true,
        };
      }

      const derivedDataPath = join(tmpdir(), "pi-tutor-derived-data");
      const args = [
        "-scheme",
        params.scheme,
        "-destination",
        params.destination ?? "generic/platform=iOS Simulator",
        "-derivedDataPath",
        derivedDataPath,
        "-disableAutomaticPackageResolution",
        "build",
      ];
      const result = await pi.exec("xcodebuild", args, { cwd: ctx.cwd, signal, timeout: 120_000 });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const bounded = output.length > 50_000 ? output.slice(-50_000) : output;
      return {
        content: [{ type: "text", text: bounded || `xcodebuild exited with code ${result.code}` }],
        isError: result.code !== 0,
        details: { code: result.code, killed: result.killed, derivedDataPath },
      };
    },
  });

  pi.registerCommand("tutor", {
    description: "Enable, disable, or inspect source-protected Tutor Mode: /tutor on|off|status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") {
        await setEnabled(true, ctx);
      } else if (action === "off") {
        await setEnabled(false, ctx);
      } else if (action === "status" || action === "") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Tutor mode is ${enabled ? "on" : "off"}.${enabled ? ` Only ${PROGRESS_PATH} is writable.` : ""}`,
            "info",
          );
        }
      } else if (ctx.hasUI) {
        ctx.ui.notify("Usage: /tutor on|off|status", "warning");
      }
    },
  });

  pi.on("tool_call", async (event) => {
    if (!enabled || ALLOWED_TOOLS.has(event.toolName)) return;
    return {
      block: true,
      reason: `Tutor mode blocks ${event.toolName}. The learner must explicitly run /tutor off before Pi can implement or mutate state.`,
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${TUTOR_PROMPT}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = false;
    toolsBeforeTutorMode = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const state = entry.data as TutorModeState | undefined;
      if (!state || typeof state.enabled !== "boolean") continue;
      enabled = state.enabled;
      toolsBeforeTutorMode = Array.isArray(state.toolsBeforeTutorMode)
        ? state.toolsBeforeTutorMode
        : undefined;
    }

    if (enabled) {
      await ensureProgressFile(ctx.cwd);
      applyTutorTools();
    }
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const toolsBeforeBranchChange = toolsBeforeTutorMode;
    const wasEnabled = enabled;
    enabled = false;
    toolsBeforeTutorMode = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const state = entry.data as TutorModeState | undefined;
      if (!state || typeof state.enabled !== "boolean") continue;
      enabled = state.enabled;
      toolsBeforeTutorMode = Array.isArray(state.toolsBeforeTutorMode)
        ? state.toolsBeforeTutorMode
        : undefined;
    }
    if (enabled) {
      applyTutorTools();
    } else if (wasEnabled && toolsBeforeBranchChange) {
      pi.setActiveTools(toolsBeforeBranchChange);
    }
    updateStatus(ctx);
  });
}
