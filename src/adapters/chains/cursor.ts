// SPDX-License-Identifier: Apache-2.0
// Scan cursor shared by the chain adapters: last seen block time per scanned account, stored as JSON, plus two
// progress markers per account. A scan reads at most pages × limit rows from `cursor − overlap`; when more rows
// than that fall into the overlap window (a burst of transactions on the account), the cursor would stay where it
// is and every later scan would re-read the same rows for good, while the heartbeat stays green. The markers
// guarantee progress: after a scan that used its whole budget without moving the cursor, the next scan starts
// exactly at the cursor (no overlap), and if even that moves nothing, at a deeper page offset.

/** Scanned account → last seen block time (unit is adapter-specific: ms on TRON, seconds on TON), and markers. */
export type TimeCursor = Record<string, number>;

const tightKey = (account: string) => `${account}#tight`;
const offsetKey = (account: string) => `${account}#offset`;

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

/** Where the next scan of `account` starts: `seen − overlap`, or `seen` itself after a scan without progress. */
export function windowStart(
  state: TimeCursor,
  account: string,
  seen: number,
  overlap: number,
  floor: number,
) {
  return Math.max(floor, state[tightKey(account)] ? seen : seen - overlap);
}

/** Page offset to resume from (TON): set only after two scans without progress. */
export function pageOffset(state: TimeCursor, account: string): number {
  return state[offsetKey(account)] ?? 0;
}

/**
 * Records the outcome of one account's scan in `next`. `exhausted`: every page of the budget was full. Returns
 * whether the scan is stuck (budget used, cursor not moved), in which case the markers make the next scan tight,
 * and after a tight scan without progress, resume at `rowsRead` further.
 */
export function recordProgress(
  next: TimeCursor,
  state: TimeCursor,
  account: string,
  before: number,
  exhausted: boolean,
  rowsRead: number,
): boolean {
  const moved = (next[account] ?? 0) > before;
  const stuck = exhausted && !moved;
  if (!stuck) {
    delete next[tightKey(account)];
    delete next[offsetKey(account)];
    return false;
  }
  if (state[tightKey(account)]) next[offsetKey(account)] = pageOffset(state, account) + rowsRead;
  next[tightKey(account)] = 1;
  return true;
}
