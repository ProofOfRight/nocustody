# nocustody

Self-hosted, **non-custodial (watch-only)** crypto payment gateway.

The gateway issues invoices, watches the merchant's own addresses on supported blockchains, strictly verifies incoming
transfers and notifies the merchant's application. It never holds private keys: funds go directly to wallets whose
keys stay offline. A compromised server does not mean stolen funds.

> **Status: early development (pre-0.1). Not ready for production use.**

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
| USDT-TRC20 (TRON) | in development |
| USDT jetton and GRAM (TON) | in development |
| EVM, Solana, Bitcoin | later |

## Development

Everything runs in Docker; the host needs only Docker and `make`.

```bash
make install   # npm ci --ignore-scripts inside the dev container
make check     # lint, typecheck, layer rules, licenses, source policy, unit and integration tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and rules.

## Documentation

- [Architecture](docs/architecture.md)
- [Security requirements](docs/security.md) and [threat model](docs/threat-model.md)
- [Architecture decision records](docs/adr/README.md)
- [Testing on TRON Nile](docs/testnet.md) and [on the TON testnet](docs/ton-testnet.md)
- Reporting vulnerabilities: [SECURITY.md](SECURITY.md)

## License

[Apache-2.0](LICENSE). As stated in section 6 of the license, it does not grant permission to use the project name.
