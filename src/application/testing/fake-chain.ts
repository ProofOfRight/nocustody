// SPDX-License-Identifier: Apache-2.0
// Scripted chain adapter for tests: candidates by page, verification results by tx hash.
import { type ChainAddress, chainAddress } from "../../domain/chain-address.ts";
import type { NetworkId } from "../../domain/network.ts";
import type { ChainAdapter, FetchResult, TransferCandidate, VerificationResult } from "../ports.ts";

export class FakeChain implements ChainAdapter {
  readonly network: NetworkId;
  pages: TransferCandidate[][] = [];
  verdicts = new Map<string, VerificationResult | Error>();

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
    return { candidates: this.pages[i] ?? [], next: String(Math.min(i + 1, this.pages.length)) };
  }

  async verify(c: TransferCandidate): Promise<VerificationResult> {
    const v = this.verdicts.get(c.ref.txHash) ?? { status: "final", transfer: c };
    if (v instanceof Error) throw v;
    return v;
  }
}
