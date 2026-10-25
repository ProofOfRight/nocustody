# 0022. Run TypeScript natively in development, compile for production

- Status: accepted
- Date: 2026-10-26

## Context

Node.js 26 can strip erasable TypeScript syntax at runtime, which removes the need for tsx or a watch build in development.

## Decision

Development and scripts run `.ts` files directly with Node. Production uses JavaScript emitted by `tsc` into `dist/`. Relative imports use `.ts` extensions, rewritten on emit by `rewriteRelativeImportExtensions`. `erasableSyntaxOnly` is enabled: no enums, namespaces or parameter properties.

## Consequences

`tsc` is used for type checking and the production build. Tests are transpiled by Vitest independently.
