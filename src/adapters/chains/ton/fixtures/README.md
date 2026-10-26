# TON fixtures

Recorded from the public **TON testnet** on 2026-10-26 (`https://testnet.toncenter.com`, `https://testnet.tonapi.io`,
no API key).

Jetton: «Testnet USD» (USDT, 6 decimals), master `0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E`.
Receiving wallet (owner): `0:326BCAF1F252CA9E3458FE73348566AFE805F7C5B40339277260BCB2FC8762B0`,
its jetton-wallet: `0:58594DDBF5AAE9EFF2BAF115DA69590BE38E07E89E79768915FDA3089C190F6B`.

- `testnet-jetton-wallet-transactions.json` — `GET /api/v3/transactions?account=<jetton-wallet>&start_utime=1792965900&end_utime=1792966200&limit=10&sort=asc`:
  two `internal_transfer` credits (the first is 1.227528 USDT with comment `586935205`).
- `testnet-jetton-wallet-credit-tx.json` — the first of them, as returned for `GET /api/v3/transactions?hash=…`
  (`transactionsByMessage` returns the same object).
- `testnet-owner-transactions.json` — `GET /api/v3/transactions?account=<owner>&start_utime=1792965900&end_utime=1792966200&limit=10&sort=asc`
  (plain GRAM transfers and the owner's `transfer_notification`s, which the jetton path ignores).
- `testnet-get-wallet-address.json` — `POST /api/v3/runGetMethod` `get_wallet_address(owner)` on the master.
- `testnet-gram-transfer-tx.json` — a plain GRAM transfer (0.484836197 GRAM, empty comment) to an active wallet.
- `testnet-tonapi-transactions.json` — tonapi `GET /v2/blockchain/accounts/<owner>/transactions` (GRAM reconciliation).
- `testnet-tonapi-jetton-wallet-transactions.json` — tonapi `GET /v2/blockchain/accounts/<jetton-wallet>/transactions?limit=10&sort_order=desc`
  (jetton reconciliation: `jetton_internal_transfer` credits and outgoing `jetton_transfer`s).

Attack cases in `adapter.test.ts` are derived from these recordings by changing the fields named in each test, e.g.
an `internal_transfer` with `forward_ton_amount = 0` and no notification, as seen on mainnet.
