export const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVARIANT_VIOLATION: "INVARIANT_VIOLATION",
  ACTION_POLICY_REQUIRED: "ACTION_POLICY_REQUIRED",
  CONTEXT_INVALID: "CONTEXT_INVALID",
  KNOWLEDGE_HASH_MISMATCH: "KNOWLEDGE_HASH_MISMATCH",
  LEASE_EXPIRED: "LEASE_EXPIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class CoordinatorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export function notFound(resource: string, id: string): CoordinatorError {
  return new CoordinatorError("NOT_FOUND", `${resource} not found: ${id}`, 404);
}

export function badRequest(message: string, details?: unknown): CoordinatorError {
  return new CoordinatorError("BAD_REQUEST", message, 400, details);
}

export function conflict(message: string, details?: unknown): CoordinatorError {
  return new CoordinatorError("CONFLICT", message, 409, details);
}

export function forbidden(message: string): CoordinatorError {
  return new CoordinatorError("FORBIDDEN", message, 403);
}

export function unauthorized(message: string = "Unauthorized"): CoordinatorError {
  return new CoordinatorError("UNAUTHORIZED", message, 401);
}
