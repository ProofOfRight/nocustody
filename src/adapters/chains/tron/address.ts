// SPDX-License-Identifier: Apache-2.0
// TRON addresses: 21 bytes (0x41 prefix + 20-byte account id), shown as base58check ("T…").
// Implemented on node:crypto to avoid a dependency (docs/adr/0015-thin-chain-clients.md).
import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));
const PREFIX = 0x41;

const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("invalid base58 character");
    n = n * 58n + v;
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? [] : [...Buffer.from(hex, "hex")];
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

/** Validates a base58check TRON address and returns it unchanged (canonical form). Throws on any error. */
export function parseTronAddress(text: string): string {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) throw new Error("not a TRON base58 address");
  const raw = base58Decode(text);
  if (raw.length !== 25) throw new Error("TRON address must decode to 25 bytes");
  const payload = raw.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(raw.subarray(21)).equals(checksum)) throw new Error("TRON address checksum mismatch");
  if (payload[0] !== PREFIX) throw new Error("TRON address must start with 0x41");
  return text;
}

/** 20-byte account id as 40 lowercase hex characters (the form used in event logs). */
export function tronAddressToHex20(base58: string): string {
  const raw = base58Decode(parseTronAddress(base58));
  return Buffer.from(raw.subarray(1, 21)).toString("hex");
}

/** From 20-byte hex (40 chars, optionally "41"-prefixed or 0-padded to a 32-byte topic) to base58check. */
export function tronAddressFromHex(hex: string): string {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(clean) || clean.length < 40) throw new Error("invalid hex address");
  const account = clean.slice(-40);
  if (clean.length === 64 && !/^0{24}$/.test(clean.slice(0, 24)))
    throw new Error("topic is not a padded address");
  if (clean.length === 42 && !clean.startsWith("41")) throw new Error("hex address must start with 41");
  if (![40, 42, 64].includes(clean.length)) throw new Error("invalid hex address length");
  const payload = Buffer.from(`41${account}`, "hex");
  return base58Encode(Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]));
}
