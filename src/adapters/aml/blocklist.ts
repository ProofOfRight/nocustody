// SPDX-License-Identifier: Apache-2.0
// Local AML screener: holds payments from addresses on an operator-maintained list (e.g. addresses published in
// sanctions lists). No external calls. One address per line; "#" starts a comment; "network:address" or a bare
// address (matches any network).
import { readFileSync } from "node:fs";
import type { AmlInput, AmlScreener, AmlVerdict } from "../../application/ports.ts";

export class BlocklistAmlScreener implements AmlScreener {
  readonly #entries: ReadonlySet<string>;

  constructor(lines: readonly string[]) {
    const entries = new Set<string>();
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line) entries.add(line.toLowerCase());
    }
    this.#entries = entries;
  }

  static fromFile(path: string): BlocklistAmlScreener {
    return new BlocklistAmlScreener(readFileSync(path, "utf8").split("\n"));
  }

  get size(): number {
    return this.#entries.size;
  }

  async screen(input: AmlInput): Promise<AmlVerdict> {
    const from = input.from.toLowerCase();
    if (this.#entries.has(from) || this.#entries.has(`${input.network}:${from}`)) {
      return { verdict: "hold", reason: "sender is on the local AML blocklist" };
    }
    return { verdict: "clear" };
  }
}
