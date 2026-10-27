# Testing on TRON Nile

The end-to-end scenario creates an invoice, has it paid on the Nile testnet and checks that it becomes `paid`
(then `completed` with the default no-op AML screener) with the events written to the outbox. It uses the production
composition root, real TronGrid and `/walletsolidity` calls and PostgreSQL from `compose.yaml`.

## Test USDT on Nile

Nile has a Tether test token: `TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf` (`TetherToken`, symbol USDT, 6 decimals). Verified
on 2026-10-26 with `POST https://nile.trongrid.io/wallet/getcontract` and live `Transfer` events. Test TRX and test
USDT are available from the Nile faucet at <https://nileex.io>. `nile.trongrid.io` works without an API key.

No custom TRC20 token is needed. If the faucet ever stops issuing USDT, deploy any standard TRC20 contract on Nile
(for example from TronIDE with TronLink) and put its address in `assets[].contract`; the adapter identifies the
asset by the contract from config only.

## Replay mode (unattended)

```bash
make up
docker compose run --rm dev npm run e2e:nile
```

Replays a recorded, solidified Nile payment of 1 USDT (tx `320a48d1…262c`). The clock is fixed two minutes before
that block so the invoice exists before the payment; the indexer query, the solidified receipt, matching,
persistence and the outbox are all live. It **resets the schema of `TEST_DATABASE_URL`**.

## Live mode (you pay)

1. Create a Nile account in TronLink (switch the network to Nile), get TRX and USDT from the faucet.
   Use a **second** account as the receiving address — the gateway only needs its public address.
2. Copy `examples/nile.config.json` to a directory **outside the repository** (the repository is mounted into the
   container, so a config inside it is one `git add` away from a commit), e.g. `~/nocustody-testnet/nile.config.json`,
   and put the receiving address into `assets[0].addresses`.
3. Run with that directory mounted read-only (it waits up to the grace period and prints the invoice state every
   15 s). Use a separate or throwaway database: an open invoice on an address that is not in this config stops the
   cycle (`invoice.address_unpinned`). The test database is reset by the tests anyway:

```bash
docker compose run --rm -v ~/nocustody-testnet:/cfg:ro -e E2E_MODE=live -e NOCUSTODY_CONFIG=/cfg/nile.config.json -e DATABASE_URL=postgres://nocustody:nocustody@postgres:5432/nocustody_test dev npm run e2e:nile
```

4. Send exactly the printed amount of USDT from the first account to the receiving address.
   The invoice becomes `paid` about a minute after the block is solidified.

## Running the worker yourself

```bash
export NOCUSTODY_CONFIG=/cfg/nile.config.json
R="docker compose run --rm -v $HOME/nocustody-testnet:/cfg:ro -e NOCUSTODY_CONFIG"
$R dev node src/app/cli.ts config:hash   # pinned checksum
$R dev npm run db:migrate
$R -e NOCUSTODY_PINNED_SHA256=<hash> dev node src/app/cli.ts invoice:create --order o1 --amount 1 --currency USD --asset usdt-nile
$R -e NOCUSTODY_PINNED_SHA256=<hash> dev node src/app/cli.ts run
```

The database role must be allowed to `CREATE EXTENSION btree_gist` once (the first migration needs it for the
amount-slot exclusion constraint); the PostgreSQL image in `compose.yaml` allows it.

## External hosts

| Host | Used for | Limits (free tier) |
|---|---|---|
| `nile.trongrid.io` / `api.trongrid.io` | candidates (`/v1/accounts/{a}/transactions/trc20`), truth (`/walletsolidity/gettransactioninfobyid`) | mainnet: 100 000 requests/day per key, `TRON-PRO-API-KEY` header |
