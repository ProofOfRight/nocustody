# TRON fixtures

Recorded from the public TRON **Nile** testnet on 2026-10-26 (`https://nile.trongrid.io`, no API key):

- `nile-trc20-history.json` — `GET /v1/accounts/TF34bV549WecfEHpo6gzMFWYrQXeHnK8Jq/transactions/trc20?only_to=true&only_confirmed=true&contract_address=TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf&limit=2&order_by=block_timestamp,desc`
  (the adapter asks for `asc`; the row shape is the same)
- `nile-tronscan-transfers.json` — Tronscan `GET /api/token_trc20/transfers` for the same address and contract
  (`nileapi.tronscan.org`), used by the reconciliation second-source tests in `src/adapters/ops-adapters.test.ts`
- `nile-solid-txinfo.json` — `POST /walletsolidity/gettransactioninfobyid` for
  `320a48d17dee9e25a1a56c48bd207b4dda550c2fb2e0c76e3e7b9f49fd70262c` (1 USDT, SUCCESS)

Attack cases in `adapter.test.ts` (fake token, failed receipt, non-final, several transfers, foreign recipient)
are derived from these recordings by changing the fields named in each test.
