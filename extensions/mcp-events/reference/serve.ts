import { createInterface } from "node:readline";
import { ReferenceServer } from "./server.ts";
import type { EventOccurrence } from "../src/types.ts";

const fixture = await ReferenceServer.start({ heartbeatMs: 1000 });
const input = createInterface({ input: process.stdin, output: process.stdout });
let last: EventOccurrence | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true; input.close(); await fixture.close();
}
console.log(`Synthetic MCP Events fixture: ${fixture.url}`);
console.log("Local controls: emit JOB_ID [EVENT_ID] | duplicate | drop | gap | silence | finish | quit");
console.log("Nothing is emitted until 'emit'. No credentials, work systems, webhook receiver or persistence.");
input.on("line", line => {
  const [command, jobId, id] = line.trim().split(/\s+/);
  if (command === "emit" && jobId) { last = fixture.emit(jobId, id); console.log(`emitted ${last.eventId}`); }
  else if (command === "duplicate" && last) fixture.duplicate(last);
  else if (command === "drop") fixture.drop();
  else if (command === "gap") fixture.gap();
  else if (command === "silence") fixture.stopHeartbeats();
  else if (command === "finish") fixture.finish();
  else if (command === "quit") void close();
  else console.log("Expected: emit JOB_ID [EVENT_ID] | duplicate | drop | gap | silence | finish | quit");
});
input.on("close", () => { void close(); });
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
