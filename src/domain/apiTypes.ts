import { v4 as uuidv4 } from "uuid";
import type { ErrorCode } from "./errors.js";

export interface Meta {
  requestId: string;
}

export interface ApiResponse<T> {
  ok: true;
  data: T;
  meta: Meta;
}

export interface ApiListResponse<T> {
  ok: true;
  data: T[];
  page: {
    limit: number;
    nextCursor: string | null;
  };
  meta: Meta;
}

export interface ApiError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  meta: Meta;
}

export function ok<T>(data: T, requestId?: string): ApiResponse<T> {
  return { ok: true, data, meta: { requestId: requestId ?? makeRequestId() } };
}

export function okList<T>(
  data: T[],
  page: { limit: number; nextCursor: string | null },
  requestId?: string,
): ApiListResponse<T> {
  return { ok: true, data, page, meta: { requestId: requestId ?? makeRequestId() } };
}

export function notOk(code: ErrorCode, message: string, details?: unknown, requestId?: string): ApiError {
  return {
    ok: false,
    error: { code, message, details },
    meta: { requestId: requestId ?? makeRequestId() },
  };
}

export function makeRequestId(): string {
  return `req_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
}
