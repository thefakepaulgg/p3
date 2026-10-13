import { expect, test } from "bun:test";
import { OrchestrationError, orchestrationError, orchestrationErrorResult } from "./errors.ts";

test("unstructured failures keep their message and do not imply rollback or safe retry", () => {
  const cause = new Error("launch failed verbatim");
  const failure = orchestrationError(cause, "launch");
  expect(failure.message).toBe(cause.message);
  expect(failure.cause).toBe(cause);
  expect(failure.detail).toEqual({
    category: "operation_failed", operation: "launch", message: cause.message,
    rollbackOccurred: false, retryAttempted: false, retrySafe: "unknown",
    nextAction: "Inspect the operation state before deciding whether to retry.",
  });
});

test("invalid input is safe to retry only when the caller explicitly knows it", () => {
  const cause = new Error("handle is required");
  expect(orchestrationError(cause, "stop").detail).toMatchObject({ category: "invalid_request", retrySafe: "unknown" });
  expect(orchestrationError(cause, "stop", { stage: "validation", retrySafe: true }).detail)
    .toMatchObject({ category: "invalid_request", stage: "validation", retrySafe: true });
});

test("rewrapping retains primary, cleanup, original stage, IDs and cause", () => {
  const cause = new Error("primary launch failure");
  const original = orchestrationError(new Error("launch failed; cleanup also failed"), "launch", {
    stage: "cleanup", ids: { paneId: "pane-1", handle: "rt-1" },
    primary: { message: cause.message }, cleanup: { message: "pane close failed" },
    rollbackOccurred: true, retryAttempted: true, retrySafe: false,
  });
  const failureWithCause = new OrchestrationError(original.detail, { cause });
  const wrapped = orchestrationError(failureWithCause, "routing:rpc:launch", {
    stage: "rpc", ids: { paneId: "different-pane", sessionId: "session-1" },
    primary: { message: "replacement" }, cleanup: { message: "replacement" },
    rollbackOccurred: false, retryAttempted: false, retrySafe: true,
  });
  expect(wrapped.message).toBe(original.message);
  expect(wrapped.cause).toBe(cause);
  expect(wrapped.detail).toMatchObject({
    operation: "routing:rpc:launch", stage: "cleanup",
    ids: { paneId: "pane-1", handle: "rt-1", sessionId: "session-1" },
    primary: { message: "primary launch failure" }, cleanup: { message: "pane close failed" },
    rollbackOccurred: true, retryAttempted: true, retrySafe: false,
  });
});

test("recognized transport uncertainty is ambiguous delivery, not safe retry", () => {
  const cause = Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
  expect(orchestrationError(cause, "launch").detail).toMatchObject({ category: "ambiguous_delivery", retrySafe: "unknown" });
  expect(orchestrationError(new Error("provider timeout"), "launch").detail.category).toBe("operation_failed");
});

test("tool errors include native isError and preserve the human message", () => {
  const result = orchestrationErrorResult(new Error("original text"), "stop", { ids: { handle: "rt-1" } });
  expect(result).toMatchObject({
    content: [{ type: "text", text: "original text" }], isError: true,
    details: { error: { operation: "stop", message: "original text", ids: { handle: "rt-1" }, retrySafe: "unknown" } },
  });
});
