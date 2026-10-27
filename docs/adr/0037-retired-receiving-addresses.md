# 0037. Retired receiving addresses; a stored address outside the pin is hidden, not fatal

- Status: accepted
- Date: 2026-10-27

## Context

Receiving addresses come only from the pinned config. An address has a status: `active` (new invoices, watched) or
`draining` (watched only). As defence in depth, every invoice read from the database was checked against the pinned
addresses of its asset, and an invoice whose stored address was not among them could not be read at all
(`invoice.address_unpinned`). The point is that somebody with write access to the database must not be able to show
payers an address of their own.

Invoices are kept forever, so the check also fired on legitimate history. Once an address was removed from the
config:

- one open invoice on it stopped `ExpireInvoices` for every invoice in the batch, and with it the worker cycle;
- `GET /v1/invoices` failed with 500 for any page containing such an invoice, and so did `GET /v1/invoices/{id}`,
  `invoice:show`, `invoice:aml-resolve` (an `aml_hold` on it could not be resolved) and a repeated create with the same
  `merchant_order_id`.

The only safe rotation was to keep the old address as `draining` forever. That does not fit the case where an address
has to go: a compromised key, or a token issuer that froze the address. Then the operator wants the address out of
scanning and out of anything a payer sees, and still needs the invoices for history and AML decisions. A merchant that
re-reads invoices from the API (on every `invoice.completed`, and hourly for reconciliation) breaks entirely on one 500.

## Decision

- A third address status, `retired`: pinned like the others (the status is part of the checksum), never used for new
  invoices, **not watched** by the scanner, the verifier or reconciliation, and never shown to payers.
- The stored address of an invoice is no longer checked when the invoice is read. It is checked where it is shown:
  the merchant API and the hosted payment page show an invoice's address, display form and wallet URI only if the
  address is a pinned, non-retired address of the invoice's asset. Otherwise `payment.address`,
  `payment.address_display` and `payment.uri` are null and `payment.address_available` is false; the page shows no
  address, amount or QR code, and tells the payer not to send funds if the invoice could otherwise still be paid.
- Crediting is unchanged: only transfers to watched addresses are verified, and a payment is applied only to an
  invoice whose stored address is its recipient. A stored address outside the pin therefore never receives a credit.
- At start-up the worker refuses to run while an invoice that could still be paid (awaiting payment, confirming,
  underpaid, or expired within its grace period) points at an address that is missing from the config altogether. Only
  closed invoices on such an address give a warning in the log. A `retired` or `draining` address passes.
- The monitor raises `invoice-address-unpinned` (critical) when an open invoice points at an address missing from the
  config. Since start-up refuses that state, it means the database was changed behind the gateway's back.
- A transfer that reaches a `retired` address after it was retired is not detected. Retiring is for an address that
  must not be used any more; such a payment is handled by hand from the wallet.

## Consequences

Removing or retiring an address no longer breaks the worker or the API. The defence against a substituted address in
the database is kept, but it moves from "fail every read" to "never show it, and alert"; every place that shows an
address to a payer must go through the same check (`isShownAddress`). The API change is additive for clients that
show `payment.address_display`, but those fields can now be null for old invoices.

Rotation without compromise stays `active` → `draining`. After a compromise or a freeze the address goes to `retired`
at once; open invoices on it stop showing payment details and expire normally.
