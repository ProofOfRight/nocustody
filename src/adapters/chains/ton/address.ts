// SPDX-License-Identifier: Apache-2.0
// TON addresses via the official @ton/core. Canonical form in this project: raw "0:<64 lowercase hex>".
import { Address } from "@ton/core";

/** Accepts raw ("0:…") or user-friendly ("EQ…"/"UQ…") form; returns the canonical raw form. Basechain only. */
export function parseTonAddress(text: string): string {
  if (!Address.isRaw(text) && !Address.isFriendly(text)) throw new Error("not a TON address");
  const a = Address.parse(text);
  if (a.workChain !== 0) throw new Error("only basechain (workchain 0) addresses are supported");
  return a.toRawString().toLowerCase();
}

/** Canonical raw form of any address string returned by a provider (raw or friendly). */
export function canonicalTon(text: string): string {
  return Address.parse(text).toRawString().toLowerCase();
}

/** User-friendly, non-bounceable form for showing to payers (wallets expect it for transfers to wallets). */
export function friendlyTon(raw: string, testnet: boolean): string {
  return Address.parse(raw).toString({ urlSafe: true, bounceable: false, testOnly: testnet });
}
