// SPDX-License-Identifier: Apache-2.0

/** Expected application-level failure with a stable `code` (e.g. no rate, no free slot). */
export class ApplicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
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
