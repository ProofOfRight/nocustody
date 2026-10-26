# 0027. Hosted payment page without external resources

- Status: accepted
- Date: 2026-10-26

## Context

Merchants may render payment instructions themselves (headless) or use a page served by the gateway. A page that
loads fonts, scripts or analytics from third parties leaks payer metadata and widens the attack surface; an address
shown from a source other than the verifier's is a substitution risk.

## Decision

Serve an optional page at `GET /pay/{invoice id}` (off by default): one HTML document with inline CSS and JS, a
strict Content-Security-Policy with a per-response nonce (`default-src 'none'`, `connect-src 'self'`,
`frame-ancestors 'none'`), `no-referrer`, `X-Frame-Options: DENY`, `noindex`. The address, amount and memo come
from the invoice's stored payment instructions — the same data the verifier matches against. The invoice id
(random UUID) is the capability; the public status endpoint returns only status, received amount and deadlines.
Languages: en, ru, fr, fa (right-to-left), zh-CN.

## Consequences

No third-party requests from payers' browsers. Non-English texts need review by native speakers. Wallet support for
`ton://transfer` links with a jetton and a comment is not verified on real wallets yet.
