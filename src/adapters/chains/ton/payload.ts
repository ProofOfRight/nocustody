// SPDX-License-Identifier: Apache-2.0
// Message bodies (TEP-74 jettons, text comments) parsed with @ton/core. Malformed input yields null, never a throw
// that could be mistaken for a decision.
import { Cell, type Slice } from "@ton/core";

export const OP_INTERNAL_TRANSFER = 0x178d4519;
export const OP_TEXT_COMMENT = 0;

const MAX_COMMENT = 1_024;

function slice(bodyBase64: string): Slice | null {
  try {
    return Cell.fromBase64(bodyBase64).beginParse();
  } catch {
    return null;
  }
}

/** Text comment from a slice that starts with op 0, or null (binary comments start with 0xff and are ignored). */
function textComment(s: Slice): string | null {
  if (s.remainingBits < 32) return null;
  if (s.loadUint(32) !== OP_TEXT_COMMENT) return null;
  const text = s.loadStringTail();
  if (text.length > MAX_COMMENT || text.startsWith("ÿ")) return null;
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
