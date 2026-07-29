/**
 * Tagged error hierarchy for the provider driver system.
 *
 * Adapted from t3code's `Errors.ts`. Uses plain TypeScript classes with
 * a `tag` discriminant instead of Effect's `TaggedErrorClass`. Each error
 * has structured fields (`driver`, `instanceId`, `detail`, `cause`) and
 * a descriptive `message` getter.
 *
 * The `tag` field enables exhaustive switch/case error handling without
 * `instanceof` checks — matching t3code's pattern where Effect's type
 * system ensures all error paths are handled.
 *
 * @module shared/provider-errors
 */

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/** Base for all provider errors — carries a `tag` discriminant. */
export abstract class ProviderError extends Error {
  abstract readonly tag: string;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Driver-level errors
// ---------------------------------------------------------------------------

/**
 * ProviderDriverError — a driver's `create()` call failed before producing
 * an instance. Surfaced to the registry, which marks the offending entry
 * as an "unavailable" shadow snapshot rather than crashing.
 */
export class ProviderDriverError extends ProviderError {
  readonly tag = "ProviderDriverError" as const;
  readonly driver: string;
  readonly instanceId: string;
  readonly detail: string;

  constructor(input: {
    driver: string;
    instanceId: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `Provider driver '${input.driver}' failed to create instance '${input.instanceId}': ${input.detail}`,
      input.cause,
    );
    this.driver = input.driver;
    this.instanceId = input.instanceId;
    this.detail = input.detail;
  }
}

/**
 * ProviderProbeError — binary/runtime not available or probe failed.
 */
export class ProviderProbeError extends ProviderError {
  readonly tag = "ProviderProbeError" as const;
  readonly driver: string;
  readonly detail: string;

  constructor(input: {
    driver: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `Provider probe failed for '${input.driver}': ${input.detail}`,
      input.cause,
    );
    this.driver = input.driver;
    this.detail = input.detail;
  }
}

/**
 * ProviderValidationError — config validation failed.
 */
export class ProviderValidationError extends ProviderError {
  readonly tag = "ProviderValidationError" as const;
  readonly operation: string;
  readonly issue: string;

  constructor(input: {
    operation: string;
    issue: string;
    cause?: unknown;
  }) {
    super(
      `Provider validation failed in ${input.operation}: ${input.issue}`,
      input.cause,
    );
    this.operation = input.operation;
    this.issue = input.issue;
  }
}

/**
 * ProviderInstanceNotFoundError — lookup against the instance registry
 * failed. The driver is registered, but no instance with the requested
 * id has been bootstrapped.
 */
export class ProviderInstanceNotFoundError extends ProviderError {
  readonly tag = "ProviderInstanceNotFoundError" as const;
  readonly instanceId: string;

  constructor(input: {
    instanceId: string;
    cause?: unknown;
  }) {
    super(
      `No provider instance bound to id '${input.instanceId}'`,
      input.cause,
    );
    this.instanceId = input.instanceId;
  }
}

// ---------------------------------------------------------------------------
// Adapter-level errors (session / turn runtime)
// ---------------------------------------------------------------------------

/**
 * ProviderAdapterValidationError — invalid adapter API input.
 */
export class ProviderAdapterValidationError extends ProviderError {
  readonly tag = "ProviderAdapterValidationError" as const;
  readonly provider: string;
  readonly operation: string;
  readonly issue: string;

  constructor(input: {
    provider: string;
    operation: string;
    issue: string;
    cause?: unknown;
  }) {
    super(
      `Provider adapter validation failed (${input.provider}) in ${input.operation}: ${input.issue}`,
      input.cause,
    );
    this.provider = input.provider;
    this.operation = input.operation;
    this.issue = input.issue;
  }
}

/**
 * ProviderAdapterSessionNotFoundError — adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends ProviderError {
  readonly tag = "ProviderAdapterSessionNotFoundError" as const;
  readonly provider: string;
  readonly sessionId: string;

  constructor(input: {
    provider: string;
    sessionId: string;
    cause?: unknown;
  }) {
    super(
      `Unknown ${input.provider} adapter session: ${input.sessionId}`,
      input.cause,
    );
    this.provider = input.provider;
    this.sessionId = input.sessionId;
  }
}

/**
 * ProviderAdapterSessionClosedError — adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends ProviderError {
  readonly tag = "ProviderAdapterSessionClosedError" as const;
  readonly provider: string;
  readonly sessionId: string;

  constructor(input: {
    provider: string;
    sessionId: string;
    cause?: unknown;
  }) {
    super(
      `${input.provider} adapter session is closed: ${input.sessionId}`,
      input.cause,
    );
    this.provider = input.provider;
    this.sessionId = input.sessionId;
  }
}

/**
 * ProviderAdapterRequestError — provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends ProviderError {
  readonly tag = "ProviderAdapterRequestError" as const;
  readonly provider: string;
  readonly method: string;
  readonly detail: string;

  constructor(input: {
    provider: string;
    method: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `Provider adapter request failed (${input.provider}) for ${input.method}: ${input.detail}`,
      input.cause,
    );
    this.provider = input.provider;
    this.method = input.method;
    this.detail = input.detail;
  }
}

/**
 * ProviderAdapterProcessError — provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends ProviderError {
  readonly tag = "ProviderAdapterProcessError" as const;
  readonly provider: string;
  readonly sessionId: string;
  readonly detail: string;

  constructor(input: {
    provider: string;
    sessionId: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `Provider adapter process error (${input.provider}) for session ${input.sessionId}: ${input.detail}`,
      input.cause,
    );
    this.provider = input.provider;
    this.sessionId = input.sessionId;
    this.detail = input.detail;
  }
}

// ---------------------------------------------------------------------------
// Union types (for exhaustive handling)
// ---------------------------------------------------------------------------

/** All adapter-level errors. */
export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

/** All provider-level errors (driver + adapter). */
export type ProviderServiceError =
  | ProviderDriverError
  | ProviderProbeError
  | ProviderValidationError
  | ProviderInstanceNotFoundError
  | ProviderAdapterError;

// ---------------------------------------------------------------------------
// Unavailable Snapshot
// ---------------------------------------------------------------------------

/**
 * Build an "unavailable" shadow snapshot for a configured instance whose
 * driver failed to probe, create, or validate. The result is structured
 * so consumers can render a "missing/failed provider" affordance.
 *
 * Adapted from t3code's `buildUnavailableProviderSnapshot`.
 */
export interface UnavailableProviderSnapshot {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly displayName: string;
  readonly available: false;
  readonly reason: string;
  readonly checkedAt: string;
}

export function buildUnavailableSnapshot(input: {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  reason: string;
}): UnavailableProviderSnapshot {
  return {
    instanceId: input.instanceId,
    driverKind: input.driverKind,
    displayName: input.displayName?.trim() || input.driverKind,
    available: false,
    reason: input.reason,
    checkedAt: new Date().toISOString(),
  };
}
