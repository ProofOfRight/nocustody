// SPDX-License-Identifier: Apache-2.0

/** Alphabet for generated memos: digits and capitals without look-alikes (0/O, 1/I/L). */
export const MEMO_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const MEMO_LENGTH = 8;

const STORED = /^[0-9A-Z]{4,32}$/;

/**
 * Canonical form of a memo typed by a payer: surrounding whitespace removed, case ignored.
 * Returns null if the text cannot be a memo, so arbitrary comments never match.
 */
export function normalizeMemo(text: string | null): string | null {
  if (text === null) return null;
  const m = text.trim().toUpperCase();
  return STORED.test(m) ? m : null;
}
