// SPDX-License-Identifier: Apache-2.0
// Scan cursor shared by the chain adapters: last seen block time per scanned account, stored as JSON.

/** Scanned account → last seen block time (unit is adapter-specific: ms on TRON, seconds on TON). */
export type TimeCursor = Record<string, number>;

/** Parses a stored cursor; entries that are not safe integers are dropped. Throws on a non-object document. */
export function parseTimeCursor(cursor: string | null, family: string): TimeCursor {
  if (!cursor) return {};
  const parsed: unknown = JSON.parse(cursor);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`invalid ${family} cursor`);
  const out: TimeCursor = {};
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === "number" && Number.isSafeInteger(v)) out[k] = v;
  return out;
}
