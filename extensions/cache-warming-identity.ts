import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Workaround for earendil-works/pi#10956: idle cache warming checks the captured context by
// message object identity, but every projection rebuilds custom_message, branch_summary,
// compaction and context-edited messages as new objects. Reuse the previous objects while
// their content is unchanged so the warmer still sees the same conversation.

const PATCHED = Symbol.for("cache-warming-identity.patched");

type Projection = { entries: Array<{ sourceEntry: { id: string; message?: unknown }; messages: unknown[] }>; messages: unknown[] };

function stabilize(manager: { buildSessionProjection(): Projection }) {
  const target = manager as unknown as Record<PropertyKey, unknown>;
  if (target[PATCHED]) return;
  target[PATCHED] = true;
  const original = manager.buildSessionProjection.bind(manager);
  const cache = new Map<string, { json: string; messages: unknown[] }>();
  manager.buildSessionProjection = () => {
    const projection = original();
    let changed = false;
    for (const entry of projection.entries) {
      const { sourceEntry, messages } = entry;
      if (messages.length === 0 || (messages.length === 1 && messages[0] === sourceEntry.message)) continue;
      const json = JSON.stringify(messages);
      const cached = cache.get(sourceEntry.id);
      if (cached?.json === json) {
        entry.messages = cached.messages;
        changed = true;
      } else {
        cache.set(sourceEntry.id, { json, messages });
      }
    }
    if (changed) projection.messages = projection.entries.flatMap(entry => entry.messages);
    return projection;
  };
}

export default function (pi: ExtensionAPI) {
  const patch = (_event: unknown, ctx: { sessionManager: unknown }) => stabilize(ctx.sessionManager as never);
  pi.on("session_start", patch);
  pi.on("before_agent_start", patch);
}
