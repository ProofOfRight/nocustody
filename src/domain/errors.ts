// SPDX-License-Identifier: Apache-2.0

/** Violation of a domain invariant. `code` is stable and meant for programs; `message` for humans. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function invariant(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
