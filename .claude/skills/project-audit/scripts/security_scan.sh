#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Mechanical part of the "Security" phase of the project-audit skill: prints CANDIDATES, not vulnerabilities.
# Every line is checked by eye against references/security.md — most will be fine (a Number() on a port, a
# fetch in the Telegram sink with its own timeout). Run from the repository root; git and python3 are enough,
# Docker only for `npm audit` (skipped with a note when unavailable):
#   bash .claude/skills/project-audit/scripts/security_scan.sh
#
# Prints no secrets: for suspicious lines only file:line.
#
# Reviewed candidates live in the baseline baseline/scan.tsv (section · file · line text without the number ·
# why · date): such lines print as "reviewed", the rest as "NEW", entries without a candidate as "stale"
# (delete them). The line number is not part of the key, so edits higher up in a file do not move it.
# What the CI already enforces (SPDX, Math.random, parseFloat, eval, invisible characters, layers, licences,
# npm audit on every push) is not repeated here except the audit, whose output is useful offline.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
BASELINE=".claude/skills/project-audit/baseline/scan.tsv"
SRC_NO_TESTS=(src ':!*.test.ts' ':!src/**/fixtures/**' ':!src/application/testing/**' ':!src/domain/test-fixtures.ts')

section() { printf '\n== %s ==\n' "$1"; }
# Verdict against the baseline: stdin — the candidates of a section, $1 — the section name in scan.tsv.
verdict() { python3 "$(dirname "$0")/scan_verdict.py" "$1" "$BASELINE"; }
ggrep() { git grep -nIE "$@" || true; }

section "External HTTP calls outside the JSON client (each: https only, host from config, timeout, size limit, schema, no redirects)"
ggrep '\bfetch\(|https?\.request\(|new WebSocket\(|\bundici\b' -- "${SRC_NO_TESTS[@]}" tools scripts ':!src/adapters/http/json-client.ts' | verdict http

section "Literal hosts in source and tooling (every external host is a config parameter and is listed in docs/operations.md)"
ggrep 'https?://[a-z0-9.-]+\.[a-z]{2,}' -- "${SRC_NO_TESTS[@]}" tools scripts | verdict hosts

section "Wall clock outside the Clock port (domain and application take time from Clock; adapters and src/app may read it)"
ggrep 'Date\.now\(\)|new Date\(\)' -- src/domain src/application ':!*.test.ts' ':!src/application/testing/**' | verdict clock

section "Focused or skipped tests left in (it.only / it.skip / it.todo prove nothing)"
ggrep '\b(it|test|describe)\.(only|skip|todo)\(' -- src scripts tools | verdict skipped

section "process.env read outside the composition root (src/app)"
ggrep 'process\.env' -- "${SRC_NO_TESTS[@]}" ':!src/app/**' | verdict env

section "Number / parseInt / rounding near amounts (bigint only; most hits are ports, decimals, pagination)"
ggrep '\bNumber\(|\bparseInt\(|\.toFixed\(|Math\.(round|floor|ceil|trunc)\(|\bnumber\b.*(amount|units|rate|price)' -- "${SRC_NO_TESTS[@]}" | verdict numbers

section "Secret comparison not through timingSafeEqual (candidates: ==/=== on a secret, token, signature or key)"
ggrep '(secret|token|signature|apiKey|api_key|password)[A-Za-z0-9_]*\s*(===|!==|==|!=)|(===|!==|==|!=)\s*[a-zA-Z_.]*(secret|token|signature|apiKey|api_key|password)' -- "${SRC_NO_TESTS[@]}" | verdict compare
printf -- '-- timingSafeEqual call sites: '
ggrep 'timingSafeEqual\(' -- "${SRC_NO_TESTS[@]}" | wc -l

section "Log statements mentioning secrets, keys or tokens (the logger redacts listed paths only, src/app/logger.ts)"
ggrep '(logger|log|this\.#log|this\.#logger)\.(info|warn|error|debug|fatal|trace)\(.*(secret|token|apiKey|api_key|authorization|signature|password|headers)' -- "${SRC_NO_TESTS[@]}" | verdict logs
printf -- '-- redacted paths: '
grep -cE '^\s+"' src/app/logger.ts || true

section "console.* in source (structured logger only; the CLI prints to the operator by design)"
ggrep 'console\.(log|error|warn|info|debug)\(' -- "${SRC_NO_TESTS[@]}" ':!src/app/cli.ts' | verdict console

section "JSON.parse without a zod schema next to it (provider answers, request bodies, config)"
ggrep 'JSON\.parse\(' -- "${SRC_NO_TESTS[@]}" | verdict jsonparse

section "API routes (scope null = public: why, which bucket; a key without the scope must get 403)"
grep -nE 'route\("(GET|POST|PUT|PATCH|DELETE)",' src/adapters/api/server.ts | sed -E 's/,\s*async.*$//' | verdict routes

section "Routes in server.ts vs docs/api/openapi.yaml (payment page routes are documented in docs/payment-page.md, not OpenAPI)"
code_routes="$(grep -oE 'route\("(GET|POST|PUT|PATCH|DELETE)", "[^"]+"' src/adapters/api/server.ts \
    | sed -E 's/route\("([A-Z]+)", "([^"]+)"/\1 \2/; s#/:([a-zA-Z_]+)#/{\1}#g' | grep -v ' /pay' | sort -u)"
doc_routes="$(awk '/^  \/[^ ]*:/ { path=$1; sub(/:$/, "", path) } /^    (get|post|put|patch|delete):/ { m=toupper($1); sub(/:$/, "", m); print m " " path }' docs/api/openapi.yaml | sort -u)"
{ comm -23 <(echo "$code_routes") <(echo "$doc_routes") | sed 's/^/in code, not in OpenAPI: /'
  comm -13 <(echo "$code_routes") <(echo "$doc_routes") | sed 's/^/in OpenAPI, not in code: /'; } | verdict openapi

section "SQL built with string interpolation (parameters must be \$n; a column list from a constant is fine)"
ggrep '\$\{' -- src/adapters/persistence ':!*.test.ts' | grep -iE 'select|insert|update|delete|where|from|order by|values|set ' | verdict sql

section "Error details that may reach API clients (message/stack/cause in responses)"
ggrep '(\.message|\.stack|\.cause)\b' -- src/adapters/api ':!*.test.ts' | verdict errors

section "Supply chain: GitHub Actions not pinned by commit SHA, workflow permissions, pull_request_target"
{ grep -nE '^\s+-?\s*uses:' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40}' | grep -vE 'uses: \./'
  grep -nE 'pull_request_target|^permissions:|^\s+permissions:' .github/workflows/*.yml; } | verdict actions

section "Images and base images without a digest (Dockerfile, compose files, workflows, scripts, Makefile)"
grep -nE '^\s*(image:|FROM |[A-Z_]*IMAGE\s*:?=)' Dockerfile compose.yaml deploy/compose.yaml .github/workflows/*.yml scripts/*.sh Makefile 2>/dev/null \
    | grep -vE '@sha256:[0-9a-f]{64}' | verdict digests

section "Dependency ranges and install scripts (exact versions only; lifecycle scripts never run)"
{ python3 -c '
import json, re
p = json.load(open("package.json"))
for block in ("dependencies", "devDependencies"):
    for name, ver in p.get(block, {}).items():
        if not re.fullmatch(r"\d+\.\d+\.\d+", ver):
            print(f"package.json: {block}.{name} = {ver}")'
  grep -q 'ignore-scripts=true' .npmrc || echo ".npmrc: ignore-scripts=true missing"; } | verdict deps

section "Ports published by compose files (dev: loopback; deploy: the API on loopback only, behind a TLS proxy)"
# Every line under a `ports:` key, including ones with variables ("127.0.0.1:${NOCUSTODY_PORT:-8080}:8080").
awk '/^[[:space:]]+ports:/ { p = 1; next } p && /^[[:space:]]+-/ { print FILENAME ":" FNR ":" $0; next } { p = 0 }' \
    compose.yaml deploy/compose.yaml | verdict ports

section "Looks like a secret in tracked files (file:line only; baseline entries keep the file column empty and 'file:line' as the text)"
{ git ls-files | grep -E '(^|/)\.env($|\.)|\.(pem|key|p12)$|id_(rsa|ed25519)' | grep -vE '\.example$'
  git grep -nIiE "(password|passwd|secret|api[_-]?key|token)['\"]?\s*[:=]\s*['\"][A-Za-z0-9+/_=-]{24,}['\"]" \
      -- . ':!package-lock.json' ':!*.test.ts' ':!examples/**' ':!docs/**' ':!.claude/**' | cut -d: -f1,2; } | verdict secrets

section "Vulnerable dependencies (npm audit; offline — open Dependabot alerts via gh)"
if docker compose run --rm --no-deps -T dev npm audit --audit-level=moderate 2>&1 | tail -n 30; then
    :
else
    echo "-- npm audit failed or no Docker/network; open Dependabot alerts:"
    gh api 'repos/{owner}/{repo}/dependabot/alerts?state=open' \
        --jq '.[] | "\(.security_advisory.severity)\t\(.dependency.package.ecosystem)/\(.dependency.package.name)\t\(.security_advisory.summary)"' \
        2>/dev/null || echo "-- gh unavailable: see Security → Dependabot on GitHub"
fi

section "Surface documented: CLI commands not mentioned in docs; webhook event types in code vs docs/api.md"
{ for cmd in $(grep -oE 'case "[a-z:-]+":' src/app/cli.ts | sed -E 's/case "([^"]+)":/\1/' | sort -u); do
      git grep -qF -- "$cmd" docs README.md || echo "CLI command not in docs: $cmd"
  done
  # Event types are emitted as `#record("invoice.x", …)` in the aggregate or as `type: "transfer.x"` elsewhere;
  # error codes share the `invoice.` prefix and are not events.
  code_events="$(git grep -hE '#record\(|type:\s*"' -- src ':!*.test.ts' | grep -oE '"(invoice|transfer)\.[a-z_]+"' | tr -d '"' | sort -u)"
  doc_events="$(grep -oE '`(invoice|transfer)\.[a-z_]+`' docs/api.md | tr -d '`' | sort -u)"
  comm -23 <(echo "$code_events") <(echo "$doc_events") | sed 's/^/event in code, not in docs\/api.md: /'
  comm -13 <(echo "$code_events") <(echo "$doc_events") | sed 's/^/event in docs\/api.md, not in code: /'; } | verdict docs
