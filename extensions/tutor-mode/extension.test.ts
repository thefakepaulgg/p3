import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tutorModeExtension from "../tutor-mode.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function harness(branch: any[] = []) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const statuses: any[] = [];
  let activeTools = ["read", "bash", "edit", "write", "lsp_diagnostics", "web_search", "subagent"];
  const execCalls: any[] = [];

  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    exec: async (command: string, args: string[], options: any) => {
      execCalls.push({ command, args, options });
      return { stdout: "BUILD SUCCEEDED", stderr: "", code: 0, killed: false };
    },
  };

  tutorModeExtension(pi);

  const makeContext = async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tutor-mode-test-"));
    tempDirs.push(cwd);
    return {
      cwd,
      hasUI: true,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: (message: string) => notifications.push(message),
        setStatus: (name: string, value: unknown) => statuses.push({ name, value }),
      },
      sessionManager: { getBranch: () => branch },
    } as any;
  };

  return {
    handlers,
    commands,
    tools,
    entries,
    notifications,
    statuses,
    execCalls,
    makeContext,
    activeTools: () => activeTools,
  };
}

describe("tutor mode", () => {
  test("enables a restricted tool set and restores the previous tools only after explicit off", async () => {
    const h = harness();
    const ctx = await h.makeContext();

    await h.commands.get("tutor").handler("on", ctx);

    expect(h.activeTools()).toEqual([
      "read",
      "lsp_diagnostics",
      "web_search",
      "tutor_progress",
      "tutor_xcode_build",
    ]);
    expect(await readFile(join(ctx.cwd, ".pi/tutor-progress.md"), "utf8")).toBe("# Tutor Progress\n\n");
    expect(await h.handlers.get("tool_call")({ toolName: "write", input: {} }, ctx)).toEqual({
      block: true,
      reason: "Tutor mode blocks write. The learner must explicitly run /tutor off before Pi can implement or mutate state.",
    });
    expect(await h.handlers.get("tool_call")({ toolName: "read", input: {} }, ctx)).toBeUndefined();

    await h.commands.get("tutor").handler("status", ctx);
    expect(h.activeTools()).not.toContain("write");

    await h.commands.get("tutor").handler("off", ctx);
    expect(h.activeTools()).toEqual(["read", "bash", "edit", "write", "lsp_diagnostics", "web_search", "subagent"]);
  });

  test("injects the teaching policy and writes only through the progress tool", async () => {
    const h = harness();
    const ctx = await h.makeContext();
    await h.commands.get("tutor").handler("on", ctx);

    const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
    expect(prompt.systemPrompt).toContain("You are a tutor, not an implementer");
    expect(prompt.systemPrompt).toContain("/tutor off");

    const progress = h.tools.get("tutor_progress");
    const result = await progress.execute("1", { action: "append", content: "## Evidence\nExplained @State." }, undefined, undefined, ctx);
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(ctx.cwd, ".pi/tutor-progress.md"), "utf8")).toContain("Explained @State.");
  });

  test("runs an Xcode build without a shell or repository derived data", async () => {
    const h = harness();
    const ctx = await h.makeContext();
    await h.commands.get("tutor").handler("on", ctx);

    const result = await h.tools.get("tutor_xcode_build").execute(
      "1",
      { scheme: "Constellation", destination: "platform=iOS Simulator,name=iPhone 17" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(h.execCalls[0].command).toBe("xcodebuild");
    expect(h.execCalls[0].args).toContain("-disableAutomaticPackageResolution");
    expect(h.execCalls[0].args).not.toContain("clean");
    expect(h.execCalls[0].options.cwd).toBe(ctx.cwd);

    const rejected = await h.tools.get("tutor_xcode_build").execute(
      "2",
      { scheme: "-help" },
      undefined,
      undefined,
      ctx,
    );
    expect(rejected.isError).toBe(true);
    expect(h.execCalls).toHaveLength(1);
  });

  test("restores enabled state from the current session branch", async () => {
    const priorTools = ["read", "bash", "edit", "write", "web_search"];
    const h = harness([{
      type: "custom",
      customType: "tutor-mode-state",
      data: { enabled: true, toolsBeforeTutorMode: priorTools },
    }]);
    const ctx = await h.makeContext();

    await h.handlers.get("session_start")({}, ctx);

    expect(h.activeTools()).toEqual(["read", "web_search", "tutor_progress", "tutor_xcode_build"]);
    expect(h.statuses.at(-1)).toEqual({ name: "tutor-mode", value: "◉ tutor" });
  });

  test("restores normal tools when navigating to a branch where Tutor Mode is off", async () => {
    const branch: any[] = [];
    const h = harness(branch);
    const ctx = await h.makeContext();
    await h.commands.get("tutor").handler("on", ctx);
    expect(h.activeTools()).not.toContain("write");

    await h.handlers.get("session_tree")({}, ctx);

    expect(h.activeTools()).toContain("write");
    expect(h.activeTools()).toContain("bash");
  });
});
