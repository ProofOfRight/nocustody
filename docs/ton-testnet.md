# Testing on the TON testnet

The TON adapter accepts jettons (e.g. USDT) and the native coin GRAM on one merchant wallet. An invoice is identified
by a memo (text comment); a unique amount is reserved as a second signal for payers who forget the comment.

## How a TON payment is verified

The indexer (toncenter v3) only supplies candidates. A payment counts only when the same transaction, re-read by
hash, is **finalized** (`finality = finalized`, included in a masterchain block, not emulated).

For **jettons** the gateway reads the transactions of **our** jetton-wallet — the one the pinned master derives for
the owner. It is pinned in config next to the owner address and checked at startup with `get_wallet_address` on the
pinned master; a mismatch stops the gateway. The token is never identified by the indexer's `jetton_master` field or
by metadata. A payment is the jetton-wallet transaction that processed `internal_transfer` (op `0x178d4519`):

- on our pinned jetton-wallet, not bounced;
- successful (not aborted, compute and action phases succeeded). The standard jetton-wallet code accepts
  `internal_transfer` only from the master or from a jetton-wallet of the same master, so a forged message fails;
- amount, sender and memo are read from the `internal_transfer` body.

The owner's `transfer_notification` is not used: the jetton-wallet sends it only when the payer sets
`forward_ton_amount` above zero (TEP-74), so relying on it would miss payments sent without one.

For **GRAM** the receiving wallet's own transaction must have no outgoing messages (no bounce, nothing returned).
For **GRAM** the amount is what the credit phase credited, not the message value.

## Test jetton

There is no official Tether test USDT on the TON testnet. The replay below uses the popular testnet jetton
"Testnet USD" (symbol USDT, 6 decimals), master `0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E`.
Any jetton works: the asset is whatever master you pin in `assets[].contract`.

## Replay mode (unattended)

```bash
make up
docker compose run --rm dev npm run e2e:ton
```

Replays two recorded, finalized testnet payments: 1.227528 test USDT with a comment (matched **by memo**) and
0.484836197 GRAM without a comment (matched **by the unique amount**). Calls to toncenter, including
`get_wallet_address`, are live. The clock is set shortly before each payment. It **resets the schema of
`TEST_DATABASE_URL`**. Without an API key toncenter allows 1 request/s, so a run takes a minute or two.

## Live mode (you pay)

1. In Tonkeeper enable the testnet, create two wallets, get test GRAM from the testnet faucet bot and test jettons
   if you want to test USDT. Use the second wallet as the receiving wallet — the gateway only needs its address.
2. Find the receiving wallet's jetton-wallet for the master, e.g.
   `https://testnet.toncenter.com/api/v3/jetton/wallets?owner_address=<wallet>&jetton_address=<master>`.
   The gateway re-checks it with `get_wallet_address` at startup, so a wrong value cannot slip through.
3. Copy `examples/ton-testnet.config.json` to a directory **outside the repository** (the repository is mounted into
   the container, so a config inside it is one `git add` away from a commit), e.g.
   `~/nocustody-testnet/ton.config.json`, and fill in the addresses. Run with that directory mounted read-only and a
   separate or throwaway database: an open invoice on an address that is not in this config stops the cycle
   (`invoice.address_unpinned`). The test database is reset by the tests anyway:

```bash
docker compose run --rm -v ~/nocustody-testnet:/cfg:ro -e E2E_MODE=live -e NOCUSTODY_CONFIG=/cfg/ton.config.json -e DATABASE_URL=postgres://nocustody:nocustody@postgres:5432/nocustody_test dev npm run e2e:ton
```

4. Send exactly the printed amount with the printed comment (a `ton://transfer/…` link is printed as well).

## External hosts

| Host | Used for | Limits (free tier) |
|---|---|---|
| `testnet.toncenter.com` / `toncenter.com` | candidates (`/api/v3/transactions?account=`), truth (`/api/v3/transactions?hash=`), `get_wallet_address` (`/api/v3/runGetMethod`) | 1 request/s without a key; with a key the `X-API-Key` header is sent and the client-side limit is off |
