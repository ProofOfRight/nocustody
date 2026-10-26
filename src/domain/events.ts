// SPDX-License-Identifier: Apache-2.0

/**
 * Every event type the gateway writes to the outbox and delivers as a webhook. docs/api.md lists them for merchants;
 * a cross-check test keeps the two lists equal. `invoice.cancelled` is reserved: the aggregate can record it, but no
 * API or command cancels an invoice yet.
 */
export const DOMAIN_EVENT_TYPES = [
  "invoice.created",
  "invoice.transfer_detected",
  "invoice.paid",
  "invoice.underpaid",
  "invoice.overpaid",
  "invoice.paid_late",
  "invoice.expired",
  "invoice.cancelled",
  "invoice.aml_pending",
  "invoice.aml_hold",
  "invoice.completed",
  "invoice.rejected",
  "transfer.unmatched",
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** Domain event. Written to the outbox in the same transaction as the state change, then delivered as a webhook. */
export interface DomainEvent {
  readonly type: DomainEventType;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}
