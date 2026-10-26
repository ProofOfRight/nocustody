# 0026. qrcode-generator for QR codes

- Status: accepted
- Date: 2026-10-26

## Context

The hosted payment page shows a QR code with the payment data. A QR encoder needs Reed–Solomon error correction,
masking and version selection; a subtle bug produces unreadable codes. Policy: minimal dependencies
([ADR-0007](0007-minimal-dependencies.md)).

## Decision

Use `qrcode-generator` 2.0.4 (Kazuhiko Arase, MIT, no dependencies, no install scripts, maintained since 2009) as a
runtime dependency, only to compute the module matrix. The SVG markup is ours (CSP-compatible, no inline styles).
Tests decode every generated code with `jsqr` 1.4.0 (Apache-2.0, dev dependency, no dependencies) and compare
the result with the input.

## Consequences

One runtime package added (32 → 33). Payloads are restricted to printable ASCII (addresses, URIs, memos).
