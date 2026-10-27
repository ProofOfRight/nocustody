# 0030. Early-payment tolerance of 5 seconds, separate from the slot margin

- Status: accepted
- Date: 2026-10-26

## Context

A transfer is matched to an invoice by (address, amount) within the invoice's slot window and by its block time
against `created_at`. Until 0.2.1 a transfer timestamped up to 30 s *before* the invoice was created still counted,
with the same constant that separates consecutive slots of one pair. That window had a cost: a transfer that landed
on a receiving address and matched no invoice (a rounded amount, a late payment past grace) could be claimed by an
invoice opened within 30 s *after* it with the same amount. On a checkout where the buyer chooses the amount, an
attacker watching the address (TRC-20 events are public within seconds) could take a stranger's payment this way.

## Decision

- Two constants with two meanings. `SLOT_CLOCK_SKEW_MS` (30 s) stays the margin between consecutive slots of one
  (address, amount) pair and the `lock_until` of PostgreSQL's exclusion constraint. `EARLY_PAYMENT_TOLERANCE_MS`
  (5 s) is how much earlier than the invoice's creation a transfer's block time may be and still be credited; it is
  used by `slotCovers` and `Invoice.applyPayment` alike.
- 5 s covers the gateway's clock running ahead of the chain. With NTP the skew is well below a second, and a human
  needs seconds to pay after seeing an invoice; a transfer that predates the invoice by more than that was not a
  payment for it.
- Allocation starts at a random slot of the pair range (`UniqueAmountStrategy`), so the pair an expired invoice just
  released is not the next one handed out: a payment after grace for the old invoice then rarely meets a new invoice
  holding the same pair. The residual risk is recorded in `docs/threat-model.md`.

## Consequences

- If the gateway's clock runs more than 5 s ahead of the chain, a payment made right after the invoice was created
  can carry a block time earlier than `created_at` − 5 s; it is quarantined as `transfer.unmatched` and resolved by
  hand. This needs a broken clock on the gateway.
- Operators who run the gateway on a host without time synchronisation must fix that first (docs/going-live.md).
