# 0003. Node.js + TypeScript (strict)

- Status: accepted
- Date: 2026-10-26

## Context

Official and mature SDKs for almost every target chain are JS/TS: TronWeb, `@ton/core`, viem, `@solana/kit`, bitcoinjs-lib. PHP SDKs for TON/Solana/EVM are weak or missing.

## Decision

Implement in TypeScript with `strict`, ESM, on Node.js (version: [ADR-0018](0018-node-26-docker-dev.md)).

## Consequences

Long-running scanners and I/O fit Node's model. npm supply-chain risk must be handled explicitly ([ADR-0007](0007-minimal-dependencies.md)).
