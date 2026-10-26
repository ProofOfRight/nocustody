// SPDX-License-Identifier: Apache-2.0
// Response schemas. Only the fields we rely on are validated; unknown fields are ignored.
import { z } from "zod";

const hex = (len?: number) => z.string().regex(len ? new RegExp(`^[0-9a-fA-F]{${len}}$`) : /^[0-9a-fA-F]*$/);

/** GET /v1/accounts/{address}/transactions/trc20 (TronGrid v1). Candidates only. */
export const trc20HistorySchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      transaction_id: hex(64),
      token_info: z.object({ address: z.string() }).passthrough(),
      block_timestamp: z.number().int().nonnegative(),
      from: z.string(),
      to: z.string(),
      type: z.string(),
      value: z.string().regex(/^\d{1,78}$/),
    }),
  ),
  meta: z.object({ fingerprint: z.string().optional() }).passthrough(),
});

/**
 * POST /walletsolidity/gettransactioninfobyid. Solidified state only: an empty object means "not solidified (yet)"
 * or unknown transaction.
 */
export const solidTxInfoSchema = z.union([
  z.object({
    id: hex(64),
    blockNumber: z.number().int().nonnegative(),
    blockTimeStamp: z.number().int().nonnegative(),
    contract_address: hex().optional(),
    result: z.string().optional(),
    receipt: z.object({ result: z.string().optional() }).passthrough(),
    log: z
      .array(
        z.object({
          address: hex(40),
          topics: z.array(hex(64)),
          data: hex().optional(),
        }),
      )
      .optional(),
  }),
  z.object({}).strict(),
]);
