export const DOMAIN_ERROR_CODES = [
  "invalid",
  "malformed",
  "not-found",
  "conflict",
  "relationship",
  "storage",
  "unsupported-version",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export type DomainResult<T> = { ok: true; value: T } | { ok: false; code: DomainErrorCode; message: string };

export function success<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function failure(code: DomainErrorCode, message: string): DomainResult<never> {
  return { ok: false, code, message };
}
