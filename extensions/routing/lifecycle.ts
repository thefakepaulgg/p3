import { ROUTING_RPC_VERSION, taskMetadata, type TaskHandle, type TaskState } from "./state.ts";

export interface LifecycleEventBus {
  emit(event: string, data: unknown): void;
}

const lifecycleStates = new Set<TaskState>(["queued", "running", "blocked", "completed", "failed", "stopped"]);

/** Emit bounded task lifecycle metadata without ever including the in-memory worker result. */
export function emitTaskLifecycle(events: LifecycleEventBus, task: TaskHandle, state: TaskState = task.state): void {
  const lifecycleState = state === "abandoned" ? "failed" : state;
  if (!lifecycleStates.has(lifecycleState)) return;
  events.emit(`routing:task:${lifecycleState}`, { version: ROUTING_RPC_VERSION, ...taskMetadata(task) });
}
