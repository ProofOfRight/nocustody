// SPDX-License-Identifier: Apache-2.0

const UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "500ms", "30s", "30m", "1h", "7d" into milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d{1,9})(ms|s|m|h|d)$/.exec(text);
  const unit = m?.[2] ? UNITS[m[2]] : undefined;
  if (!m?.[1] || unit === undefined)
    throw new Error(`invalid duration ${JSON.stringify(text)} (use e.g. 30s, 30m, 1h, 7d)`);
  return Number(m[1]) * unit;
}
