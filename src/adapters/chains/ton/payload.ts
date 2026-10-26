// SPDX-License-Identifier: Apache-2.0
// Message bodies (TEP-74 jettons, text comments) parsed with @ton/core. Malformed input yields null, never a throw
// that could be mistaken for a decision.
import { Cell, type Slice } from "@ton/core";

export const OP_INTERNAL_TRANSFER = 0x178d4519;
export const OP_TEXT_COMMENT = 0;
/** Wallet apps' "encrypt comment" option: a plain coin transfer whose comment the gateway cannot read. */
export const OP_ENCRYPTED_COMMENT = 0x2167da4b;

const MAX_COMMENT = 1_024;

function slice(bodyBase64: string): Slice | null {
  try {
    return Cell.fromBase64(bodyBase64).beginParse();
  } catch {
    return null;
  }
}

/**
 * Control characters other than tab, newline and carriage return, and U+FFFD (invalid UTF-8 decoded), make a comment
 * "not text". A payer controls the comment; PostgreSQL refuses U+0000 in `text`, so such a comment is treated as
 * absent and never stored, and the transfer itself is still verified.
 */
function isText(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfffd) return false;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return false;
    if (cp >= 0x7f && cp <= 0x9f) return false;
  }
  return true;
}

/**
 * Text comment from a slice that starts with op 0, or null. Binary comments (TEP-74) start with the byte 0xff: it
 * is checked on the raw bits, because UTF-8 decoding turns that byte into U+FFFD, not "ÿ".
 */
function textComment(s: Slice): string | null {
  if (s.remainingBits < 32) return null;
  if (s.loadUint(32) !== OP_TEXT_COMMENT) return null;
  if (s.remainingBits >= 8 && s.preloadUint(8) === 0xff) return null;
  const text = s.loadStringTail();
  if (text.length > MAX_COMMENT || !isText(text)) return null;
  return text;
}

/** forward_payload:(Either Cell ^Cell) — inline remainder or a referenced cell. */
function forwardPayloadComment(s: Slice): string | null {
  if (s.remainingBits < 1) return null;
  const inRef = s.loadBit();
  if (inRef) return s.remainingRefs > 0 ? textComment(s.loadRef().beginParse()) : null;
  return textComment(s);
}

export interface InternalTransfer {
  readonly queryId: bigint;
  readonly amount: bigint;
  /** Owner of the sending jetton wallet (raw form), or null for addr_none (e.g. a mint). */
  readonly from: string | null;
  readonly forwardTonAmount: bigint;
  readonly comment: string | null;
}

/**
 * internal_transfer#178d4519 query_id:uint64 amount:(VarUInteger 16) from:MsgAddress response_address:MsgAddress
 * forward_ton_amount:(VarUInteger 16) forward_payload:(Either Cell ^Cell) — the message that credits a jetton
 * wallet. It reaches our jetton wallet for every transfer, whatever forward_ton_amount the sender chose.
 */
export function parseInternalTransfer(bodyBase64: string): InternalTransfer | null {
  const s = slice(bodyBase64);
  if (!s) return null;
  try {
    if (s.loadUint(32) !== OP_INTERNAL_TRANSFER) return null;
    const queryId = s.loadUintBig(64);
    const amount = s.loadCoins();
    const from = s.loadMaybeAddress();
    s.loadMaybeAddress(); // response_address
    const forwardTonAmount = s.loadCoins();
    let comment: string | null = null;
    try {
      comment = forwardPayloadComment(s);
    } catch {
      comment = null; // a malformed payload must not hide a valid transfer; it just carries no memo
    }
    return {
      queryId,
      amount,
      from: from ? from.toRawString().toLowerCase() : null,
      forwardTonAmount,
      comment,
    };
  } catch {
    return null;
  }
}

/** Comment of a plain (native coin) transfer body, or null. */
export function parsePlainComment(bodyBase64: string | null | undefined): string | null {
  if (!bodyBase64) return null;
  const s = slice(bodyBase64);
  if (!s) return null;
  try {
    return textComment(s);
  } catch {
    return null;
  }
}
