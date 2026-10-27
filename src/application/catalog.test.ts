// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { STRICT_AMOUNT_POLICY, uniqueAmountPolicy } from "../domain/amount-policy.ts";
import { chainAddress } from "../domain/chain-address.ts";
import { TRON, USDT_TRON } from "../domain/test-fixtures.ts";
import {
  AssetCatalog,
  type AssetSettings,
  isShownAddress,
  unpinnedUsage,
  watchedAddresses,
} from "./catalog.ts";

const ACTIVE = chainAddress(TRON, "TAddrA111111111111111111111111111");
const DRAINING = chainAddress(TRON, "TAddrD111111111111111111111111111");
const RETIRED = chainAddress(TRON, "TAddrR111111111111111111111111111");
const settings: AssetSettings = {
  asset: USDT_TRON,
  priceSymbol: "USDT",
  strategy: "unique-amount",
  addresses: [
    { address: ACTIVE, status: "active", tokenAccount: null },
    { address: DRAINING, status: "draining", tokenAccount: null },
    { address: RETIRED, status: "retired", tokenAccount: null },
  ],
  amountPolicy: STRICT_AMOUNT_POLICY,
  uniqueAmount: uniqueAmountPolicy({ stepUnits: 10_000n, maxSlots: 99 }),
  ttlMs: 1_800_000,
  graceMs: 3_600_000,
  amlThresholdUnits: 0n,
};

describe("receiving address statuses (ADR-0037)", () => {
  it("a retired address is neither watched nor shown; active and draining are both", () => {
    expect(watchedAddresses(settings)).toEqual([ACTIVE, DRAINING]);
    expect(isShownAddress(settings, ACTIVE.value)).toBe(true);
    expect(isShownAddress(settings, DRAINING.value)).toBe(true);
    expect(isShownAddress(settings, RETIRED.value)).toBe(false);
    expect(isShownAddress(settings, "TUnpinned1111111111111111111111111")).toBe(false);
  });

  it("only addresses missing from the pin count as unpinned; retired ones are pinned", () => {
    const usage = [ACTIVE.value, RETIRED.value, "TUnpinned1111111111111111111111111"].map((address) => ({
      assetId: USDT_TRON.id,
      address,
      open: 1,
      total: 1,
    }));
    expect(unpinnedUsage(new AssetCatalog([settings]), usage).map((u) => u.address)).toEqual([
      "TUnpinned1111111111111111111111111",
    ]);
  });
});
