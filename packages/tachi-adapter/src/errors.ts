/**
 * Typed adapter errors.
 *
 * Every failure crossing the adapter boundary carries a stable `code`. The API maps these to
 * HTTP statuses and the UI renders the `code` as a badge, so "the quote went stale" and "the
 * daemon is down" are distinguishable to a merchant instead of both being a red toast.
 */
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 502,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The daemon could not be reached at all (DNS, TLS, timeout, connection refused). */
export class DaemonUnreachableError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("daemon_unreachable", message, 503, details);
  }
}

/** The daemon answered, but reported a failure (non-zero ABCI code, JSON-RPC error, 4xx/5xx). */
export class DaemonRejectedError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("daemon_rejected", message, 502, details);
  }
}

/** A payment proof no longer describes a live VTXO — the route must be re-quoted and re-detected. */
export class ProofStaleError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("proof_stale", message, 409, details);
  }
}

/** A route or account cannot cover the requested amount. */
export class InsufficientCapacityError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("insufficient_capacity", message, 409, details);
  }
}

/** The operation is understood but not available in the current mode/configuration. */
export class NotSupportedError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_supported", message, 501, details);
  }
}

/** The daemon refused a broadcast at CheckTx or FinalizeBlock; `log` carries its explanation. */
export class TransferRejectedError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("transfer_rejected", message, 422, details);
  }
}

/** Signing material is missing or unusable. Never includes key material in the message. */
export class KeyMaterialError extends AdapterError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("key_material", message, 500, details);
  }
}

export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

/** Classify an unknown throw from SDK/fetch into an AdapterError, preserving the cause's text. */
export function toAdapterError(error: unknown, context: string): AdapterError {
  if (isAdapterError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage = cause instanceof Error ? ` (cause: ${cause.message})` : "";
  const transport = /fetch failed|timed out|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|certificate|SSL|network/i.test(
    message,
  );
  return transport
    ? new DaemonUnreachableError(`${context}: ${message}${causeMessage}`)
    : new DaemonRejectedError(`${context}: ${message}${causeMessage}`);
}
