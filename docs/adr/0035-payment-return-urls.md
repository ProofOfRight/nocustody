# 0035. Return URLs on the hosted payment page

- Status: accepted
- Date: 2026-10-27

## Context

After paying on the hosted page ([ADR-0027](0027-hosted-payment-page.md)) the payer has no way back to the
merchant's website, and a payer who changed their mind has nowhere to go either. Merchants expect to pass the URLs
to return to. A URL taken from a request and shown as a link on a page served from the gateway's host is an
open-redirect and phishing risk: whoever holds an API key, or can write the database, could send payers anywhere
from a page they trust. Merchants also tend to treat a visit to a "success" URL as proof of payment.

## Decision

- `POST /v1/invoices` takes optional `success_url` and `cancel_url` (at most 2048 characters). Each must be https,
  without credentials, on an origin listed in `api.paymentPage.returnOrigins`; otherwise the request is refused with
  `422 return_url_not_allowed`. The list is empty by default, so the feature is off until the operator names the
  merchant's origins.
- The URLs are stored with the invoice and returned in the invoice object. They are not part of the order: a retry
  for the same `merchant_order_id` with other URLs returns the existing invoice with the URLs it was created with.
- The page shows a "Back to the merchant's website" link, never an automatic redirect, and appends nothing to the
  URL: `success_url` once the payment is received (`paid`, `overpaid`, `paid_late`, `completed`, `aml_pending`),
  `cancel_url` otherwise. The origin is checked again when the page is rendered, so a URL changed in the database or
  an origin removed from the config is not shown.
- `returnOrigins` is not part of the pinned checksum ([ADR-0031](0031-pinned-config-scope.md)): a return URL never
  decides whether or how much is credited.
- The documentation states that a visit to `success_url` is not a payment; orders are credited from webhooks or
  `GET /v1/invoices/{id}`.

## Consequences

Merchants get a way back for payers without a redirect the gateway does not control. Adding a merchant origin is an
operator change in config, without a new pin. One migration adds two nullable columns to `invoices`.
