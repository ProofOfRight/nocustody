// SPDX-License-Identifier: Apache-2.0
// Scripted chain adapter for tests: candidates by page, verification results by tx hash.
import { type ChainAddress, chainAddress } from "../../domain/chain-address.ts";
import type { NetworkId } from "../../domain/network.ts";
import { txRef } from "../../domain/tx-ref.ts";
import type { ChainAdapter, FetchResult, TransferCandidate, VerificationResult } from "../ports.ts";

export class FakeChain implements ChainAdapter {
  readonly network: NetworkId;
  pages: TransferCandidate[][] = [];
  verdicts = new Map<string, VerificationResult | Error>();
  /** Reported with every fetch: the scan used its whole page budget. */
  exhausted = false;

  constructor(network: NetworkId) {
    this.network = network;
  }

  supports(): boolean {
    return true;
  }

  validateAddress(raw: string): ChainAddress {
    return chainAddress(this.network, raw);
  }

  buildPaymentUri(): string | null {
    return null;
  }

  async fetchIncoming(_asset: unknown, _addresses: unknown, cursor: string | null): Promise<FetchResult> {
    const i = cursor ? Number(cursor) : 0;
    return {
      candidates: this.pages[i] ?? [],
      next: String(Math.min(i + 1, this.pages.length)),
      exhausted: this.exhausted,
    };
  }

  /** Default: final, one transfer equal to the hint at log index 0. */
  async verify(c: TransferCandidate): Promise<VerificationResult> {
    const v = this.verdicts.get(c.txHash) ?? {
      status: "final",
      transfers: [
        {
          ref: txRef(c.network, c.txHash, 0n),
          from: c.from,
          to: c.to,
          amount: c.amount,
          at: c.at,
          memo: c.memo,
        },
      ],
    };
    if (v instanceof Error) throw v;
    return v;
  }
}
