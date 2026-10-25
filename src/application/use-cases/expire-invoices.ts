// SPDX-License-Identifier: Apache-2.0
import type { Clock, UnitOfWork } from "../ports.ts";

/** Marks invoices whose TTL elapsed without a detected transfer as expired. Their slots stay locked until grace. */
export interface ExpireInvoicesDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly batchSize: number;
}

export class ExpireInvoices {
  readonly #deps: ExpireInvoicesDeps;

  constructor(deps: ExpireInvoicesDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<number> {
    const { uow, clock, batchSize } = this.#deps;
    return uow.run(async (repos) => {
      const now = clock.now();
      let count = 0;
      for (const invoice of await repos.invoices.listExpirable(now, batchSize)) {
        if (invoice.expire(now)) {
          await repos.invoices.update(invoice);
          await repos.outbox.append(invoice.pullEvents());
          count++;
        }
      }
      return count;
    });
  }
}
