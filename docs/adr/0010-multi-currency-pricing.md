# 0010. Multi-currency pricing as a first-class requirement

- Status: accepted
- Date: 2026-10-26

## Context

The gateway is universal: merchants price in any fiat currency (RUB, CNY, IRR, JPY, EUR, BRL, …), possibly several at once.

## Decision

Currencies (ISO 4217 registry) and rate providers are config and `RateProvider` adapters, not core code. Rate conversion is implemented; per-currency price lists exist in the domain and are planned for the API. See [architecture.md](../architecture.md#pricing-and-amounts).

## Consequences

Domain needs bigint minor units, rational rates, quote-age checks and explicit rounding policy.
