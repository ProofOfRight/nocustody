# 0031. The pinned checksum covers everything that decides money, not only addresses

- Status: accepted
- Date: 2026-10-26

## Context

Until 0.2.1 `NOCUSTODY_PINNED_SHA256` covered the assets (identity, decimals) and their receiving addresses with
status and jetton-wallet. The threat model treats "somebody changes `config.json`" as in scope, and the deployment
guide promised that a changed config blocks new invoices. But a config writer who left the addresses alone could
still get invoices credited without paying: point `apiUrl` at a host that answers "final, SUCCESS" (the same
endpoint answers the finality query), raise `underpaymentTolerance` so dust counts as paid, set a `manualRates`
entry that makes every invoice cost almost nothing, switch `ops.aml` off, or send the webhooks elsewhere. None of
that changed the checksum, so nothing alerted.

## Decision

- The checksum (`nocustody-pinned-v2`) is the SHA-256 of a canonical JSON of: per asset its identity, addresses
  with status and jetton-wallet, amount policy (step, slots, dust, underpayment tolerance, late payments), TTL,
  grace, AML threshold, strategy and price symbol; the provider sections that answer the finality queries
  (`network`, `apiUrl`, `apiKeyEnv`); `pricing` (currencies, markup, manual rates); `ops.aml` (provider and blocklist path, not the list itself);
  `ops.depeg` (symbol, deviation limit, sources; not `interval`); the
  webhook URL with `allowPrivateNetworks` and `allowHttp`. Amounts are compared in units, so a different spelling
  of the same amount is the same pin.
- Not pinned, so operators can tune them without a new pin: timeouts, poll intervals, overlap, response limits,
  API bind address and rate limits, alerts, retention, `candidateMaxAge`, `maxScannerLag`, `maxDispatcherLag`,
  reconciliation sources (they only produce candidates for the normal verifier), log level.
- A provider key variable (`apiKeyEnv`, `botTokenEnv`) may not name another secret (`database.urlEnv`,
  `webhooks.secretEnv`, the pinned checksum, `NOCUSTODY_DB_PASSWORD`) or look like a database variable (`POSTGRES_*`,
  `PG*`, `DATABASE_*`): otherwise the database password would travel to a
  provider as an API key.
- The guard that re-reads the file still compares this checksum: it runs before every invoice and once a minute in
  the monitor, and alerts through the alert router.

## Consequences

- Every deployment upgrading to this version must run `config:hash` again and update `NOCUSTODY_PINNED_SHA256`;
  the gateway refuses to start until it does (CHANGELOG).
- Changing a manual rate, a policy or a provider URL needs a new pin. That is the point: these changes are reviewed
  like an address change. The pin stays in `.env`, which should have a different owner than `config.json` where
  that is possible (docs/deployment.md).
- What the pin cannot do: protect against an attacker who can write both `config.json` and `.env`. For that the
  canary on another host remains the control.
