# nocustody

[![CI](https://github.com/ProofOfRight/nocustody/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ProofOfRight/nocustody/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ProofOfRight/nocustody)](https://github.com/ProofOfRight/nocustody/releases)
[![License](https://img.shields.io/github/license/ProofOfRight/nocustody)](LICENSE)
[![Signed provenance](https://img.shields.io/badge/provenance-signed-2ea44f)](https://github.com/ProofOfRight/nocustody/attestations)

Self-hosted, **non-custodial (watch-only)** crypto payment gateway.

The gateway issues invoices, watches the merchant's own addresses on supported blockchains, strictly verifies incoming
transfers and notifies the merchant's application. It never holds private keys: funds go directly to wallets whose
keys stay offline. A compromised server does not mean stolen funds.

> **Status: 0.5, early release.** Verified end to end on the TRON Nile and TON testnets and with a read-only replay
> of real mainnet payments; no production deployment yet. Start with small amounts.

## Principles

- **No private keys on the server.** Only addresses (and, later, xpubs). See [ADR-0002](docs/adr/0002-watch-only.md).
- **No phoning home.** No telemetry, update checks or author-operated servers. External requests go only to the
  blockchain and rate providers the operator configures explicitly.
- **Strict verification.** A transfer counts only when it is final and successful according to an independent
  query, for the asset contract pinned in config — never by token symbol or metadata.
- **Multi-chain through adapters, multi-currency pricing** in any ISO 4217 currency.
- **Small, auditable code base** with a decision log for every credited or rejected payment.

Non-goals: holding funds, signing transactions, payouts, refunds, sweeps, exchange, KYC.

## Networks

| Network / asset | Status |
|---|---|
| USDT-TRC20 (TRON) | testnet-verified, mainnet replay |
| USDT jetton (TON) | testnet-verified, mainnet replay |
| GRAM (TON) | testnet-verified |
| EVM, Solana, Bitcoin | later |

## Running

The release image is `ghcr.io/proofofright/nocustody` ([verify it](docs/deployment.md#verify-the-image) before use).
Start from the example [deploy/compose.yaml](deploy/compose.yaml) and the [deployment guide](docs/deployment.md).

## Development

Everything runs in Docker; the host needs Docker, `make` and `git` (`make smoke-image` also uses `curl`).

```bash
make install   # npm ci --ignore-scripts inside the dev container
make check     # lint, typecheck, layer rules, licenses, source policy, unit and integration tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and rules.

## Documentation

- [Deployment](docs/deployment.md) and [configuration reference](docs/configuration.md)
- [Going live on mainnet](docs/going-live.md) (checklist, read-only mainnet check, test payments)
- [Merchant API and webhooks](docs/api.md) ([OpenAPI](docs/api/openapi.yaml), examples: [PHP](examples/php/), [Laravel](examples/laravel/))
- [Hosted payment page](docs/payment-page.md) (optional)
- [Operations](docs/operations.md) (monitoring, reconciliation, depeg, AML, canary)
- [Architecture](docs/architecture.md)
- [Security requirements](docs/security.md) and [threat model](docs/threat-model.md)
- [Architecture decision records](docs/adr/README.md)
- [Testing on TRON Nile](docs/testnet.md) and [on the TON testnet](docs/ton-testnet.md)
- [Changelog](CHANGELOG.md), [releasing](docs/releasing.md)
- Reporting vulnerabilities: [SECURITY.md](SECURITY.md)

## Support the project

Crypto donations: see [DONATE.md](DONATE.md).

## License

[Apache-2.0](LICENSE). As stated in section 6 of the license, it does not grant permission to use the project name.
