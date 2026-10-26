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
  (status, received amount and deadlines only — no order id, no payments, no sender addresses);
- languages: English, Russian, French, Persian (right-to-left), Simplified Chinese — `?lang=` or the browser's
  `Accept-Language`.

## Security

- No external resources: inline CSS and JS only, strict `Content-Security-Policy` with a fresh nonce per response,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `noindex`.
- The address comes from the invoice's stored payment instructions, which were taken from the pinned config — the
  same data the verifier matches against.
- The invoice id (random UUID) is the only key to the page; do not log full page URLs in places others can read.
- Public routes share one rate limit (`publicRateLimitPerMinute`).

## Not verified yet

- Texts other than English were written without native speakers — please review before production use.
- Support of `ton://transfer` links with `jetton` and `text` in Tonkeeper, Walt (formerly Telegram Wallet) and
  MyTonWallet has not been tested on real wallets.
