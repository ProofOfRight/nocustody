// SPDX-License-Identifier: Apache-2.0
import { ApplicationError } from "../errors.ts";
import type { Clock, UnitOfWork } from "../ports.ts";

/** Manual decision on an invoice held by AML screening (operator CLI). */
export class ResolveAmlHold {
  readonly #uow: UnitOfWork;
  readonly #clock: Clock;

  constructor(uow: UnitOfWork, clock: Clock) {
    this.#uow = uow;
    this.#clock = clock;
  }

  async execute(invoiceId: string, approve: boolean, note: string): Promise<string> {
    return this.#uow.run(async (r) => {
      const inv = await r.invoices.findById(invoiceId);
      if (!inv) throw new ApplicationError("invoice.not_found", `invoice ${invoiceId} not found`);
      const now = this.#clock.now();
      inv.resolveAmlHold(approve, now);
      await r.invoices.update(inv);
      await r.outbox.append(inv.pullEvents());
      await r.audit.record({
        at: now,
        actor: "aml",
        subject: inv.id,
        decision: approve ? "approved" : "rejected",
        reason: `manual decision: ${note}`,
      });
      return inv.status;
    });
  }
}
