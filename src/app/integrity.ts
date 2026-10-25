// SPDX-License-Identifier: Apache-2.0
import type { IntegrityGuard } from "../application/ports.ts";
import { type AddressValidators, loadConfigFile } from "./config.ts";

/**
 * Re-reads the config file and compares its pinned checksum with the one supplied at deploy time. A change on disk
 * (which would take effect on the next restart) stops new invoices immediately and is reported via `onViolation`.
 */
export class ConfigFilePinGuard implements IntegrityGuard {
  readonly #path: string;
  readonly #expected: string;
  readonly #validators: AddressValidators;
  readonly #onViolation: (reason: string) => void;

  constructor(
    path: string,
    expected: string,
    validators: AddressValidators,
    onViolation: (reason: string) => void,
  ) {
    this.#path = path;
    this.#expected = expected;
    this.#validators = validators;
    this.#onViolation = onViolation;
  }

  async check(): Promise<{ ok: true } | { ok: false; reason: string }> {
    let actual: string;
    try {
      actual = loadConfigFile(this.#path, this.#validators).pinnedChecksum;
    } catch (e) {
      return this.#fail(`config unreadable: ${e instanceof Error ? e.message : e}`);
    }
    return actual === this.#expected
      ? { ok: true }
      : this.#fail("pinned checksum mismatch: addresses or contracts changed");
  }

  #fail(reason: string): { ok: false; reason: string } {
    this.#onViolation(reason);
    return { ok: false, reason };
  }
}
