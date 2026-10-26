// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineAsset, sameAsset } from "./asset.ts";
import { chainAddress, sameAddress } from "./chain-address.ts";
import { formatDecimal, parseDecimal } from "./decimal.ts";
import { DomainError } from "./errors.ts";
import { Money } from "./money.ts";
import { networkFamily, networkId } from "./network.ts";
import { TRON, USDT_TRON } from "./test-fixtures.ts";
import { parseTxRefKey, txRef, txRefKey } from "./tx-ref.ts";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : "not-a-domain-error";
  }
  return undefined;
};

describe("decimal", () => {
  it("parses exact decimals into units", () => {
    expect(parseDecimal("10.01", 6)).toBe(10_010_000n);
    expect(parseDecimal("0", 2)).toBe(0n);
    expect(parseDecimal("1.50", 1)).toBe(15n); // trailing zeros are not extra precision
    expect(parseDecimal("123", 0)).toBe(123n);
  });

  it("never rounds and rejects malformed input", () => {
    expect(code(() => parseDecimal("1.001", 2))).toBe("decimal.precision");
    for (const bad of ["", "-1", "+1", "1e3", " 1", "1.", ".5", "01", "1,5", "0x10", "NaN"]) {
      expect(code(() => parseDecimal(bad, 6))).toBe("decimal.syntax");
    }
  });

  it("round-trips any non-negative amount", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 40n }),
        fc.integer({ min: 0, max: 18 }),
        (units, scale) => {
          expect(parseDecimal(formatDecimal(units, scale), scale)).toBe(units);
        },
      ),
    );
  });

  it("formats with exactly `scale` fractional digits", () => {
    expect(formatDecimal(1n, 6)).toBe("0.000001");
    expect(formatDecimal(10_010_000n, 6)).toBe("10.010000");
    expect(formatDecimal(5n, 0)).toBe("5");
    expect(formatDecimal(-5n, 2)).toBe("-0.05");
  });
});

describe("network and asset", () => {
  it("validates network ids", () => {
    expect(networkFamily(networkId("evm:56"))).toBe("evm");
    expect(code(() => networkId("tron"))).toBe("network.invalid");
    expect(code(() => networkId("TRON:mainnet"))).toBe("network.invalid");
  });

  it("identifies assets by contract, never by symbol", () => {
    const fake = defineAsset({ ...USDT_TRON, id: "fake", contract: "TFakeContract1111111111111111111111" });
    const renamed = defineAsset({ ...USDT_TRON, id: "other-id", symbol: "XYZ" });
    expect(sameAsset(USDT_TRON, fake)).toBe(false);
    expect(sameAsset(USDT_TRON, renamed)).toBe(true);
  });

  it("enforces contract presence by kind and sane decimals", () => {
    expect(code(() => defineAsset({ ...USDT_TRON, contract: null }))).toBe("asset.contract");
    expect(code(() => defineAsset({ ...USDT_TRON, kind: "native" }))).toBe("asset.contract");
    expect(code(() => defineAsset({ ...USDT_TRON, decimals: 1.5 }))).toBe("asset.decimals");
    expect(code(() => defineAsset({ ...USDT_TRON, id: "Bad Id" }))).toBe("asset.id");
  });
});

describe("Money", () => {
  it("parses and formats in asset precision", () => {
    expect(Money.parse(USDT_TRON, "10.01").units).toBe(10_010_000n);
    expect(Money.of(USDT_TRON, 1n).toDecimalString()).toBe("0.000001");
    expect(code(() => Money.parse(USDT_TRON, "0.0000001"))).toBe("decimal.precision");
  });

  it("is non-negative", () => {
    expect(code(() => Money.of(USDT_TRON, -1n))).toBe("money.negative");
    expect(code(() => Money.of(USDT_TRON, 1n).minus(Money.of(USDT_TRON, 2n)))).toBe("money.negative");
  });

  it("refuses to mix assets", () => {
    const fake = defineAsset({ ...USDT_TRON, id: "fake", contract: "TFakeContract1111111111111111111111" });
    expect(code(() => Money.of(USDT_TRON, 1n).plus(Money.of(fake, 1n)))).toBe("money.asset_mismatch");
    expect(Money.of(USDT_TRON, 1n).equals(Money.of(fake, 1n))).toBe(false);
  });

  it("compares exactly", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        (a, b) => {
          const ma = Money.of(USDT_TRON, a);
          const mb = Money.of(USDT_TRON, b);
          expect(ma.equals(mb)).toBe(a === b);
          expect(ma.diff(mb)).toBe(a - b);
          expect(ma.compare(mb)).toBe(a < b ? -1 : a > b ? 1 : 0);
        },
      ),
    );
  });
});

describe("ChainAddress and TxRef", () => {
  it("compares canonical addresses per network", () => {
    const a = chainAddress(TRON, "TXYZ");
    expect(sameAddress(a, chainAddress(TRON, "TXYZ"))).toBe(true);
    expect(sameAddress(a, chainAddress(networkId("tron:nile"), "TXYZ"))).toBe(false);
    expect(code(() => chainAddress(TRON, "T X"))).toBe("address.invalid");
  });

  it("builds a stable idempotency key", () => {
    const ref = txRef(TRON, "a".repeat(64), 2n);
    expect(txRefKey(ref)).toBe(`tron:mainnet/${"a".repeat(64)}/2`);
    expect(code(() => txRef(TRON, "short", 0n))).toBe("txref.hash");
    expect(code(() => txRef(TRON, "a".repeat(64), -1n))).toBe("txref.index");
    // the key is parsed back where a stored payment is screened: it must round-trip and refuse anything else
    expect(parseTxRefKey(txRefKey(ref))).toEqual(ref);
    for (const bad of [
      "a/b",
      "tron:mainnet/abc",
      `tron:mainnet/${"a".repeat(64)}/x`,
      `tron:mainnet/${"a".repeat(64)}/1/2`,
    ])
      expect(
        code(() => parseTxRefKey(bad)),
        bad,
      ).toBe("txref.key");
  });
});
