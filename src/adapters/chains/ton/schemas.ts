// SPDX-License-Identifier: Apache-2.0
// toncenter v3 response schemas (only the fields we rely on). See /api/v3/doc.json.
import { z } from "zod";

const b64hash = z.string().regex(/^[A-Za-z0-9+/_-]{43}=?$/);
const raw = z.string().regex(/^-?\d+:[0-9A-Fa-f]{64}$/);
const uint = z.string().regex(/^\d{1,40}$/);

/** swagger: 0 pending / 1 confirmed / 2 finalized; testnet returns the names as strings. */
const finality = z.union([z.number().int(), z.string()]);

const message = z.object({
  hash: b64hash,
  source: raw.nullable(),
  destination: raw.nullable(),
  value: uint.nullable(),
  opcode: z.string().nullable(),
  bounce: z.boolean().nullable(),
  bounced: z.boolean().nullable(),
  message_content: z.object({ body: z.string().nullable() }).passthrough().nullable(),
});

export const tonTransactionSchema = z.object({
  account: raw,
  hash: b64hash,
  lt: uint,
  now: z.number().int().nonnegative(),
  mc_block_seqno: z.number().int().nullable().optional(),
  emulated: z.boolean().optional(),
  finality: finality.optional(),
  description: z.object({
    aborted: z.boolean(),
    destroyed: z.boolean().optional(),
    credit_ph: z.object({ credit: uint.optional() }).passthrough().optional(),
    compute_ph: z
      .object({ skipped: z.boolean().optional(), success: z.boolean().nullable().optional() })
      .passthrough(),
    action: z.object({ success: z.boolean().nullable().optional() }).passthrough().nullable().optional(),
  }),
  in_msg: message.nullable(),
  out_msgs: z.array(message),
});

export type TonTransaction = z.infer<typeof tonTransactionSchema>;

export const tonTransactionsSchema = z.object({ transactions: z.array(tonTransactionSchema) });

export const runGetMethodSchema = z.object({
  exit_code: z.number().int(),
  stack: z.array(z.object({ type: z.string(), value: z.string() })),
});

export function isFinalized(t: TonTransaction): boolean {
  return (
    (t.finality === 2 || t.finality === "finalized") &&
    t.emulated !== true &&
    typeof t.mc_block_seqno === "number" &&
    t.mc_block_seqno > 0
  );
}
