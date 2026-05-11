/**
 * Authority context — types for human guardian permissions and veto rights.
 *
 * Authority assignments are stored on the Organization aggregate; this
 * context only adds the canonical authority-name enum and helper guards.
 */

export const AUTHORITY_NAMES = [
  "submit-human-input",
  "answer-request",
  "approve-resource-creation",
  "veto-proposal",
  "pause-mechanism",
  "pause-settlement",
  "emergency-intervention",
] as const;

export type AuthorityName = (typeof AUTHORITY_NAMES)[number];

export function isKnownAuthority(value: string): value is AuthorityName {
  return (AUTHORITY_NAMES as readonly string[]).includes(value);
}
