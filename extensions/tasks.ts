import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
  id: number;
  text: string;
  status: TaskStatus;
}

interface TaskDetails {
  action: string;
  tasks: Task[];
  nextId: number;
  affectedId?: number;
  error?: string;
}

const TaskParams = Type.Object({
  action: StringEnum(["list", "add", "start", "complete", "reopen", "update", "remove", "clear_completed"] as const),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Task ID" })),
  text: Type.Optional(Type.String({ minLength: 1, description: "Task text for add or update" })),
});

class TaskListComponent {
  constructor(
    private readonly tasks: Task[],
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines = ["", truncateToWidth(th.fg("accent", th.bold(" Session Tasks")), width), ""];
    if (this.tasks.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks")}`, width));
    } else {
      const completed = this.tasks.filter((task) => task.status === "completed").length;
      lines.push(truncateToWidth(`  ${th.fg("muted", `${this.tasks.length - completed} open · ${completed} completed`)}`, width), "");
      for (const task of this.tasks) {
        const marker = task.status === "completed" ? th.fg("success", "✓") : task.status === "in_progress" ? th.fg("warning", "●") : th.fg("dim", "○");
        const text = task.status === "completed" ? th.fg("dim", task.text) : th.fg("text", task.text);
        lines.push(truncateToWidth(`  ${marker} ${th.fg("accent", `#${task.id}`)} ${text}`, width));
      }
    }
    lines.push("", truncateToWidth(`  ${th.fg("dim", "Escape to close")}`, width), "");
    return lines;
  }

  invalidate(): void {}
}

export default function tasksExtension(pi: ExtensionAPI) {
  let tasks: Task[] = [];
  let nextId = 1;

  const snapshot = (action: string, affectedId?: number, error?: string): TaskDetails => ({
    action,
    tasks: tasks.map((task) => ({ ...task })),
    nextId,
    affectedId,
    error,
  });

  const updateWidget = (ctx: ExtensionContext) => {
    const open = tasks.filter((task) => task.status !== "completed");
    if (open.length === 0) {
      ctx.ui.setWidget("session-tasks", undefined);
      return;
    }
    const lines = [ctx.ui.theme.fg("muted", `Tasks · ${open.length} open`)];
    for (const task of open.slice(0, 4)) {
      const marker = task.status === "in_progress" ? ctx.ui.theme.fg("warning", "●") : ctx.ui.theme.fg("dim", "○");
      lines.push(`${marker} ${ctx.ui.theme.fg("accent", `#${task.id}`)} ${task.text}`);
    }
    if (open.length > 4) lines.push(ctx.ui.theme.fg("dim", `… ${open.length - 4} more · /tasks`));
    ctx.ui.setWidget("session-tasks", lines);
  };

  const reconstruct = (ctx: ExtensionContext) => {
    tasks = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task_list") continue;
      const details = entry.message.details as TaskDetails | undefined;
      if (!details) continue;
      tasks = details.tasks.map((task) => ({ ...task }));
      nextId = details.nextId;
    }
    updateWidget(ctx);
  };

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "task_list",
    label: "Task List",
    description: "Manage the current Pi session's branch-aware task list. Use only for work with multiple meaningful steps or explicit commitments. Actions: list, add, start, complete, reopen, update, remove, clear_completed.",
    promptSnippet: "Track meaningful multi-step work in the current session",
    promptGuidelines: [
      "Use task_list when multi-step work or explicit commitments would otherwise be lost; keep it current, but do not create tasks for simple work or as ceremony.",
    ],
    parameters: TaskParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requireTask = (): Task | undefined => params.id === undefined ? undefined : tasks.find((task) => task.id === params.id);
      let message = "";
      let affectedId: number | undefined;
      let error: string | undefined;

      switch (params.action) {
        case "list":
          message = tasks.length === 0 ? "No tasks" : tasks.map((task) => `${task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]"} #${task.id} ${task.text}`).join("\n");
          break;
        case "add": {
          const text = params.text?.trim();
          if (!text) { error = "text is required"; break; }
          const task: Task = { id: nextId++, text, status: "pending" };
          tasks.push(task);
          affectedId = task.id;
          message = `Added #${task.id}: ${task.text}`;
          break;
        }
        case "start":
        case "complete":
        case "reopen": {
          const task = requireTask();
          if (!task) { error = params.id === undefined ? "id is required" : `task #${params.id} not found`; break; }
          task.status = params.action === "start" ? "in_progress" : params.action === "complete" ? "completed" : "pending";
          affectedId = task.id;
          message = `Task #${task.id} is ${task.status.replace("_", " ")}`;
          break;
        }
        case "update": {
          const task = requireTask();
          const text = params.text?.trim();
          if (!task) { error = params.id === undefined ? "id is required" : `task #${params.id} not found`; break; }
          if (!text) { error = "text is required"; break; }
          task.text = text;
          affectedId = task.id;
          message = `Updated #${task.id}: ${task.text}`;
          break;
        }
        case "remove": {
          const task = requireTask();
          if (!task) { error = params.id === undefined ? "id is required" : `task #${params.id} not found`; break; }
          tasks = tasks.filter((candidate) => candidate.id !== task.id);
          affectedId = task.id;
          message = `Removed #${task.id}`;
          break;
        }
        case "clear_completed": {
          const count = tasks.filter((task) => task.status === "completed").length;
          tasks = tasks.filter((task) => task.status !== "completed");
          message = `Cleared ${count} completed task${count === 1 ? "" : "s"}`;
          break;
        }
      }

      if (error) message = `Error: ${error}`;
      updateWidget(ctx);
      return { content: [{ type: "text", text: message }], details: snapshot(params.action, affectedId, error) };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tasks ")) + theme.fg("muted", args.action);
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.text) text += ` ${theme.fg("dim", JSON.stringify(args.text))}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as TaskDetails | undefined;
      const block = result.content.find((item) => item.type === "text");
      const text = block?.type === "text" ? block.text : "";
      return new Text(details?.error ? theme.fg("error", text) : theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerCommand("tasks", {
    description: "Show the current session task list",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(tasks.length ? tasks.map((task) => `#${task.id} ${task.status}: ${task.text}`).join("\n") : "No tasks", "info");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _keys, done) => new TaskListComponent(tasks, theme, () => done()));
    },
  });
}
