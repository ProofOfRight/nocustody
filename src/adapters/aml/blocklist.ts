// SPDX-License-Identifier: Apache-2.0
// Local AML screener: holds payments from addresses on an operator-maintained list (e.g. addresses published in
// sanctions lists). No external calls. One address per line; "#" starts a comment; "network:address" or a bare
// address (matches any network). Entries are normalised with the network's own address parser, so an address
// written in any accepted form (TON user-friendly, TRON base58) matches the canonical form the chain adapters
// report; a line that is not an address of any configured network is a start-up error, never silently ignored.
import { readFileSync } from "node:fs";
import type { AmlInput, AmlScreener, AmlVerdict } from "../../application/ports.ts";
import { type NetworkId, networkId } from "../../domain/network.ts";

/** Canonical form of `raw` for `network`, or for any configured network family when `network` is null; throws. */
export type AddressNormaliser = (network: NetworkId | null, raw: string) => string;

const PREFIXED = /^([a-z]+:[a-z0-9-]+):(.+)$/;

export class BlocklistAmlScreener implements AmlScreener {
  readonly #entries: ReadonlySet<string>;

  constructor(lines: readonly string[], normalise: AddressNormaliser) {
    const entries = new Set<string>();
    lines.forEach((raw, i) => {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) return;
      try {
        const m = PREFIXED.exec(line);
        if (m?.[1] && m[2]) {
          const network = networkId(m[1]);
          entries.add(`${network}:${normalise(network, m[2].trim())}`);
        } else {
          entries.add(normalise(null, line));
        }
      } catch (e) {
        throw new Error(`AML blocklist line ${i + 1}: ${e instanceof Error ? e.message : e}`);
      }
    });
    this.#entries = entries;
  }

  static fromFile(path: string, normalise: AddressNormaliser): BlocklistAmlScreener {
    return new BlocklistAmlScreener(readFileSync(path, "utf8").split("\n"), normalise);
  }

  get size(): number {
    return this.#entries.size;
  }

  async screen(input: AmlInput): Promise<AmlVerdict> {
    if (this.#entries.has(input.from) || this.#entries.has(`${input.network}:${input.from}`)) {
      return { verdict: "hold", reason: "sender is on the local AML blocklist" };
    }
    return { verdict: "clear" };
  }
}
