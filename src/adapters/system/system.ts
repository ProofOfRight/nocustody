// SPDX-License-Identifier: Apache-2.0
import { randomInt, randomUUID } from "node:crypto";
import type { Clock, IdGenerator, MemoGenerator } from "../../application/ports.ts";
import { MEMO_ALPHABET, MEMO_LENGTH } from "../../domain/memo.ts";

export const systemClock: Clock = { now: () => new Date() };

export const cryptoIds: IdGenerator = { newId: () => randomUUID() };

/** Memo of MEMO_LENGTH characters drawn uniformly from MEMO_ALPHABET with node:crypto. */
export const cryptoMemos: MemoGenerator = {
  newMemo: () =>
    Array.from({ length: MEMO_LENGTH }, () => MEMO_ALPHABET[randomInt(MEMO_ALPHABET.length)]).join(""),
};
