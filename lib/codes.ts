import { randomBytes, randomInt } from 'node:crypto';

/**
 * Session codes.
 *
 * Six characters from an unambiguous alphabet (no I, L, O, 0 or 1) giving
 * 31^6 = ~887 million combinations, which is ample when join attempts are rate
 * limited per IP and sessions expire after an hour.
 */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/;

export function generateCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return code;
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function isValidCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * Accepts "abc def", "abc-def" or "abcdef" and normalises to "ABCDEF".
 * Returns null when the result is not a well formed code.
 */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return isValidCode(cleaned) ? cleaned : null;
}

// Display formatting lives in the client-safe protocol module.
export { formatCode } from './protocol';
