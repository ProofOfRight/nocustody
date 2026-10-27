# Going live on mainnet

A checklist for the first production deployment. It assumes the gateway runs as described in
[deployment.md](deployment.md) and is configured from [examples/mainnet.config.json](../examples/mainnet.config.json)
(USDT on TRON and TON). Do the steps in order; do not skip the small-amount test payments.

## 1. Receiving wallets

- [ ] The receiving addresses belong to a hardware wallet (or another wallet whose keys never touch the server). Check
      with the vendor that it supports both TRON and TON. The gateway never needs the keys.
- [ ] Each address is copied from the wallet and **confirmed on the device screen**, not taken from a chat, an e-mail
      or a previous config.
- [ ] TON: the owner's USDT jetton-wallet is in `jettonWallet`. Look it up with
      `GET https://toncenter.com/api/v3/jetton/wallets?owner_address=<owner>&jetton_address=<USDT master>`; the gateway
      checks it with `get_wallet_address` on the pinned master at startup and refuses to start on a mismatch.
- [ ] The USDT contracts in `assets[].contract` are the official ones (TRON `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`,
      TON master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`), checked against Tether's website and a block
      explorer.

## 2. Provider accounts

Every external host is configured explicitly; nothing else is contacted ([security.md](security.md)).

| Purpose | Host | Key variable in the example |
|---|---|---|
| TRON scanner and finality checks | `api.trongrid.io` | `TRONGRID_API_KEY` (header `TRON-PRO-API-KEY`) |
| TON scanner and finality checks | `toncenter.com` | `TONCENTER_API_KEY` (header `X-API-Key`) |
| TRON reconciliation | `apilist.tronscanapi.com` | `TRONSCAN_API_KEY` |
| TON reconciliation | `tonapi.io` | `TONAPI_KEY` |
| Depeg check (no key) | `api.kraken.com`, `api.exchange.coinbase.com` | — |
| Alerts | `api.telegram.org` | `NOCUSTODY_TG_TOKEN` |

- [ ] Keys created, stored only in `.env` (`chmod 600`).
- [ ] The key headers for Tronscan and tonapi depend on the plan; if a request is refused, set `apiKeyHeader` in
      `ops.reconcile.tron` / `ops.reconcile.ton` ([operations.md](operations.md)).
- [ ] TronGrid and toncenter are reachable **from the server**: run `make e2e-mainnet` there from a source checkout
      (below). It does not contact Tronscan, tonapi, the exchanges or Telegram: check those with the first
      reconciliation run, `ops:status` (depeg reading) and a test alert (section 5).

## 3. Configuration

- [ ] The server's clock is synchronised (NTP). A transfer whose block time is more than 5 s before the invoice was
      created is quarantined, not credited ([ADR-0030](adr/0030-early-payment-tolerance.md)).
- [ ] `startFrom` is the go-live time (scanning starts there when there is no cursor yet).
- [ ] `amounts`: `step` and `maxSlots` give `maxSlots` parallel invoices per address and base price; add addresses
      for more. `dustThreshold` ignores tiny transfers (address poisoning).
- [ ] `ttl` and `grace`: long enough for the payer, short enough to free slots; payments in `grace` become `paid_late`.
- [ ] Prices: every enabled currency has a manual rate with a sensible `maxAge`; an expired rate refuses new invoices
      with `pricing.no_rate`. Somebody owns updating them.
- [ ] Depeg protection, reconciliation and alerts are on.
- [ ] `config:hash` computed after the last edit and set as `NOCUSTODY_PINNED_SHA256`
      ([configuration.md](configuration.md#pinned-checksum)).

## 4. Read-only mainnet check

From a source checkout on the server (Docker only):

```bash
make install
make up
make e2e-mainnet
```

It replays real, recent, finalized USDT payments of other people (TRON and TON) through the scanner, the finality
verifier and settlement against the live providers. Nothing is sent and no keys are involved. It shows that the
providers answer from this host and that their responses are what the gateway expects. `TRONGRID_API_KEY` from the
environment is passed to the dev container; `TONCENTER_API_KEY` is not, so the TON part runs without a key (1
request/s).

## 5. Deploy

- [ ] Image verified and pinned by digest ([deployment.md](deployment.md#verify-the-image)).
- [ ] TLS reverse proxy: `/v1/*` only for the merchant backend, `/pay/*` public if the payment page is used.
- [ ] Webhook endpoint of the merchant verifies signatures ([api.md](api.md)); the secret is not the API key.
- [ ] `ops:status` shows scanner heartbeats for both networks.
- [ ] The address canary runs from another host ([operations.md](operations.md#address-canary)).
- [ ] A test alert reached the operator. Stopping the gateway sends nothing: the monitor runs in the same process
      (watch `/health` from outside for that). For example, set `ops.maxScannerLag` of one network shorter than its
      `pollInterval` (not pinned), restart, wait for `scanner-lag:<network>` within a minute or two, then revert.

## 6. Small-amount test payments

Pay from a wallet that is not a receiving wallet, 1–2 USDT each:

- [ ] TRON: exact amount → `completed`, webhook `invoice.paid` and `invoice.completed` received and verified.
- [ ] TON with the memo → `completed`.
- [ ] TON without the memo, exact amount → `completed` by the unique-amount fallback.
- [ ] Less than the amount → `underpaid`, webhook `invoice.underpaid`. On TON a top-up with the same memo is added
      and completes the invoice; on TRON a top-up has a different amount, matches no slot (`transfer.unmatched`) and
      is settled by the merchant manually.
- [ ] After expiry, within grace → webhook `invoice.paid_late`, then `completed` (`paid_late` is an event, not a
      stored status), or not credited if `acceptLatePayments` is off.
- [ ] `invoice:show <id>` shows the status, the received amount, the payments and the webhook events for each case;
      the reasons of the decisions are in the `audit_log` table.
- [ ] Reconciliation runs without findings.

## 7. Operating

- [ ] Funds are moved from the receiving addresses to cold storage regularly, manually, from the hardware wallet.
      Keep some TRX (energy) and TON (gas) on the receiving wallets for that.
- [ ] Withdrawal addresses come from the wallet's address book, never from the transaction history
      (address poisoning).
- [ ] Database backups are scheduled ([deployment.md](deployment.md#backups)).
- [ ] An `address_pin_violation` alert means: stop issuing invoices, compare the config with the wallet, find out how
      it changed.
