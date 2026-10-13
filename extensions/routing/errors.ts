export interface OrchestrationErrorDetails {
  category: string;
  operation: string;
  message: string;
  stage?: string;
  /** Known pane, session, or task handles only; never credentials or transcripts. */
  ids?: Record<string, string | undefined>;
  rollbackOccurred: boolean;
  retryAttempted: boolean;
  retrySafe: boolean | "unknown";
  nextAction: string;
  primary?: { message: string };
  cleanup?: { message: string };
}

export class OrchestrationError extends Error {
  detail: OrchestrationErrorDetails;

  constructor(detail: OrchestrationErrorDetails, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "OrchestrationError";
    this.detail = detail;
  }
}

export function orchestrationError(
  error: unknown,
  operation: string,
  options: Partial<OrchestrationErrorDetails> = {},
): OrchestrationError {
  const message = error instanceof Error ? error.message : String(error);
  const original = error instanceof OrchestrationError ? error.detail : undefined;
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  const category = original?.category ?? options.category ?? (
    code === "ETIMEDOUT" || code === "ECONNRESET" ? "ambiguous_delivery"
      : /^(?:invalid\b|\w+ is required$|\w+ must\b)/i.test(message) ? "invalid_request" : "operation_failed"
  );
  const detail: OrchestrationErrorDetails = {
    category,
    operation,
    message,
    rollbackOccurred: original?.rollbackOccurred === true || options.rollbackOccurred === true,
    retryAttempted: original?.retryAttempted === true || options.retryAttempted === true,
    retrySafe: original?.retrySafe === false ? false : options.retrySafe ?? original?.retrySafe ?? "unknown",
    nextAction: options.nextAction ?? original?.nextAction ?? "Inspect the operation state before deciding whether to retry.",
  };
  const stage = original?.stage ?? options.stage;
  const ids = original?.ids || options.ids ? { ...options.ids, ...original?.ids } : undefined;
  const primary = original?.primary ?? options.primary;
  const cleanup = original?.cleanup ?? options.cleanup;
  if (stage !== undefined) detail.stage = stage;
  if (ids !== undefined) detail.ids = ids;
  if (primary !== undefined) detail.primary = primary;
  if (cleanup !== undefined) detail.cleanup = cleanup;
  // Rewrapping changes context, not the underlying failure or its cause.
  return new OrchestrationError(detail, { cause: original ? (error as OrchestrationError).cause ?? error : error });
}

export function orchestrationErrorResult(
  error: unknown,
  operation: string,
  options?: Partial<OrchestrationErrorDetails>,
): { content: [{ type: "text"; text: string }]; details: { error: OrchestrationErrorDetails }; isError: true } {
  const failure = orchestrationError(error, operation, options);
  return { content: [{ type: "text", text: failure.message }], details: { error: failure.detail }, isError: true };
}
