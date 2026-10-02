import { setTimeout as delay } from "node:timers/promises";

export async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Condition deadline expired");
    await delay(5);
  }
}
export { delay };
