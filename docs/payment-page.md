# Hosted payment page

Optional. Enable it in config:

```json
"api": { "paymentPage": { "enabled": true, "defaultLanguage": "en", "publicRateLimitPerMinute": 600 } }
```

Every invoice then has `payment.page` = `/pay/{id}` in the API response. Redirect the payer to
`https://<your gateway host>/pay/{id}` or show your own page using `payment.address_display`, `payment.amount`,
`payment.memo` and `payment.uri` (headless).

## What the page does

- shows the exact amount, network, address and (TON) memo with copy buttons and a QR code;
- QR content: the wallet link when the network has one (TON: `ton://transfer/…` with amount, jetton and comment),
  otherwise the address (TRON) — the payer types the amount;
- a countdown to `expires_at` and the invoice status, refreshed every 10 seconds from `GET /pay/{id}/status`
  (status, received amount and deadlines only — no order id, no payments, no sender addresses) until the invoice is
  final or its grace period is over; `underpaid` keeps polling (a top-up completes it);
- for an invoice that can no longer be paid (expired past grace, cancelled, completed) the page shows the status only:
  no amount, address or QR code, so a payer who opens an old link cannot send to a pair a newer invoice may hold;
- a "Back to the merchant's website" link when the invoice has return URLs: `success_url` once the payment is
  received, `cancel_url` until then. Only https URLs on an origin from `api.paymentPage.returnOrigins` are accepted
  and shown; the page never redirects by itself ([ADR-0035](adr/0035-payment-return-urls.md),
  [api.md](api.md#creating-invoices));
- light theme only; the font is the system one (Inter when it is installed on the payer's device), no web fonts;
- languages: English, Russian, French, Persian (right-to-left), Simplified Chinese — `?lang=` or the browser's
  `Accept-Language`.

## Security

- A visit to `success_url` is not a payment: anybody can open it. Credit orders from webhooks or the API only.
- No external resources: inline CSS and JS only, strict `Content-Security-Policy` with a fresh nonce per response,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `noindex`.
- The address comes from the invoice's stored payment instructions, which were taken from the pinned config — the
  same data the verifier matches against.
- The invoice id (random UUID) is the only key to the page; do not log full page URLs in places others can read.
- Public routes share one rate limit (`publicRateLimitPerMinute`, default 600 per minute for everybody behind the
  proxy together). Each open page polls six times a minute, so about 100 open pages reach the default, and one client
  in a loop can starve every payer of the page. **Rate-limit `/pay/*` per client address at the reverse proxy**
  (nginx `limit_req`, Caddy `rate_limit`) and raise `publicRateLimitPerMinute` to what your proxy lets through.

## Not verified yet

- Texts other than English were written without native speakers — please review before production use.
- Support of `ton://transfer` links with `jetton` and `text` in Tonkeeper, Walt (formerly Telegram Wallet) and
  MyTonWallet has not been tested on real wallets.
