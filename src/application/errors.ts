// SPDX-License-Identifier: Apache-2.0

/**
 * Every application error code. The API maps each one to an HTTP status (a `Record` over this union, so a new code
 * without a status is a type error, not a silent 422).
 */
export type ApplicationErrorCode =
  | "asset.unknown"
  | "config.duplicate_asset"
  | "allocation.bad_memo"
  | "allocation.memo_collision"
  | "allocation.no_address"
  | "allocation.no_free_slot"
  | "integrity.pin_violation"
  | "invoice.address_unpinned"
  | "invoice.not_found"
  | "invoice.order_mismatch"
  | "invoice.zero_amount"
  | "pricing.currency_disabled"
  | "pricing.depeg_block"
  | "pricing.no_rate";

/** Expected application-level failure with a stable `code` (e.g. no rate, no free slot). */
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

/** Optimistic-locking conflict; the operation can be retried. */
export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}
