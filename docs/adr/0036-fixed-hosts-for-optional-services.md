# 0036. Fixed hosts for the depeg check and Telegram alerts

- Status: accepted
- Date: 2026-10-27

## Context

[security.md](../security.md) said that every external host is an explicit config parameter. Chain providers are:
`apiUrl` in config, pinned ([ADR-0031](0031-pinned-config-scope.md)). Three hosts are not: the depeg check
(`ops.depeg.sources`) calls `api.kraken.com` and `api.exchange.coinbase.com`, and Telegram alerts
(`ops.alerts.telegram`) call `api.telegram.org`. Config only switches them on; the host is in the adapter. Each of
these adapters parses one vendor's response format, so a configurable URL would only allow pointing them at a host
that speaks the same format.

## Decision

- These three hosts stay fixed in code. They are contacted only when the operator enables the feature in config, and
  `ops.depeg.sources` is pinned, so enabling a source needs a new checksum.
- Every such host is listed in the documentation ([operations.md](../operations.md), "External hosts";
  [going-live.md](../going-live.md)). A new fixed host needs an ADR.
- The rule in security.md reads: every external host is either a config parameter or a fixed host of a feature the
  config enables, and is documented.

## Consequences

An operator who must route these calls through an allowlisting proxy configures that proxy for the documented hosts.
No request leaves the gateway for a host that neither config nor this ADR names.
