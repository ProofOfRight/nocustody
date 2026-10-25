// SPDX-License-Identifier: Apache-2.0
import type { AmlScreener, AmlVerdict } from "../../application/ports.ts";

/** Default AML screener: no external calls, every payment is clear. */
export class NoopAmlScreener implements AmlScreener {
  async screen(): Promise<AmlVerdict> {
    return { verdict: "clear" };
  }
}
