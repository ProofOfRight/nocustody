// SPDX-License-Identifier: Apache-2.0

/** Domain event. Written to the outbox in the same transaction as the state change, then delivered as a webhook. */
export interface DomainEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}
