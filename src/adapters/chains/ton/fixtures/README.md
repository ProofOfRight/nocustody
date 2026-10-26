# TON fixtures

Recorded from the public **TON testnet** on 2026-10-26 (`https://testnet.toncenter.com`, no API key).

Jetton: «Testnet USD» (USDT, 6 decimals), master `0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E`.
Receiving wallet (owner): `0:326BCAF1F252CA9E3458FE73348566AFE805F7C5B40339277260BCB2FC8762B0`,
its jetton-wallet: `0:58594DDBF5AAE9EFF2BAF115DA69590BE38E07E89E79768915FDA3089C190F6B`.

- `testnet-owner-transactions.json` — `GET /api/v3/transactions?account=<owner>&start_utime=1792965900&end_utime=1792966200&limit=10&sort=asc`
- `testnet-notification-{1,2}-tx.json` — `GET /api/v3/transactions?hash=…` for the two `transfer_notification`
  transactions (1.227528 USDT, comment `586935205`; and the next one). Both are `aborted` with `compute_ph.reason = no_gas`
  (forward amount 1 nanoton) — normal for jetton notifications.
- `testnet-notification-{1,2}-jetton-wallet-tx.json` — `GET /api/v3/transactionsByMessage?msg_hash=<in_msg.hash>&direction=out`
  (the jetton-wallet transaction that processed `internal_transfer` and emitted the notification).
- `testnet-get-wallet-address.json` — `POST /api/v3/runGetMethod` `get_wallet_address(owner)` on the master.
- `testnet-gram-transfer-tx.json` — a plain GRAM transfer (0.484836197 GRAM, empty comment) to an active wallet.

Attack cases in `adapter.test.ts` are derived from these recordings by changing the fields named in each test.
