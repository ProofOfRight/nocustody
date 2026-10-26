#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Emptiness check for a "fix + test" commit: the new tests must be green with the fix and red without it.
# Instead of the manual "break the code — run — restore from a copy", the commit's code is reverted in a
# separate git worktree (the working directory is untouched) and the tests run in their own compose project
# `nocustody-bites` (own PostgreSQL; the dev stand is not touched). node_modules of the main checkout are
# mounted into the worktree (the lockfile is the same within one audit). Needs Docker Compose 2.24 or newer:
# the override that unpublishes the PostgreSQL port uses the `!reset` YAML tag.
#
# Usage (from the repository root):
#   bash .claude/skills/project-audit/scripts/test_bites.sh <commit> [<commit>…] [--tests=path,path]
#
# For each commit: the test files come from the *.test.ts files in the commit (or --tests), the new titles
# from the "+ it("…")" lines of its diff.
#   1. run on the commit: must be green (otherwise "red even with the fix");
#   2. `git apply -R` of the commit's diff without tests, fixtures and fakes — the code without the fix;
#   3. run again; per new title from the JSON report: failed → BITES; passed → DOES NOT BITE;
#      missing → NOT RUN (the file filter did not cover it).
# Exit code 1 when any test does not bite or the revert did not apply. A test for code the commit did not
# change cannot be proven this way — break the code by hand from a copy of the file (SKILL.md, main rules).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
ROOT="$(pwd)"
# A fresh private directory: a predictable path under /tmp could be pre-created by another user of the host.
SCRATCH="${SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/nocustody-bites.XXXXXX")}"
PROJECT=nocustody-bites
TEST_SIDE=(':!*.test.ts' ':!src/**/fixtures/**' ':!src/application/testing/**' ':!src/domain/test-fixtures.ts')

tests_opt=""; commits=()
for a in "$@"; do
    case "$a" in --tests=*) tests_opt="${a#--tests=}" ;; *) commits+=("$a") ;; esac
done
[ "${#commits[@]}" -gt 0 ] || { sed -n '3,20p' "$0"; exit 2; }

fail=0
# The dev stand publishes PostgreSQL on 127.0.0.1:55432; the bites project must not (an override resets the ports).
compose() { docker compose -p "$PROJECT" --project-directory "$wt" -f "$wt/compose.yaml" -f "$wt/.cache/bites.override.yaml" "$@"; }
write_override() {
    mkdir -p "$wt/.cache"
    printf 'services:\n  postgres:\n    ports: !reset []\n' > "$wt/.cache/bites.override.yaml"
}
cleanup() {
    if [ -n "${wt:-}" ] && [ -d "$wt" ]; then
        compose down -v --remove-orphans >/dev/null 2>&1 || true
        git worktree remove --force "$wt" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

run_tests() {   # $1 — JSON report path relative to the worktree, $2… — test files
    local out="$1"; shift
    compose run --rm -T -v "$ROOT/node_modules:/app/node_modules:ro" dev \
        npx vitest run --reporter=json --outputFile="$out" "$@" >/dev/null 2>&1
}

for c in "${commits[@]}"; do
    sha="$(git rev-parse --short "$c" 2>/dev/null)" || { echo "✗ $c: no such commit"; fail=1; continue; }
    printf '\n== %s %s ==\n' "$sha" "$(git log -1 --format=%s "$c")"
    if [ -n "$tests_opt" ]; then
        files="$(tr ',' ' ' <<< "$tests_opt")"
    else
        files="$(git show --name-only --format= "$c" -- '*.test.ts' | paste -sd' ')"
    fi
    [ -n "$files" ] || { echo "✗ the commit has no *.test.ts files and no --tests"; fail=1; continue; }
    titles="$(git show --format= "$c" -- '*.test.ts' | grep -oE '^\+\s*(it|test)\("[^"]+"' | sed -E 's/^\+\s*(it|test)\("//; s/"$//' | sort -u)"
    echo "  test files: $files"
    if [ -z "$titles" ]; then
        echo "✗ the diff adds no it(\"…\")/test(\"…\") line (strengthened assertions, it.each, template-literal titles): check by hand from a copy of the file"
        fail=1; continue
    fi
    echo "  new titles: $(grep -c . <<< "$titles")"

    wt="$SCRATCH/wt-$sha"
    rm -rf "$wt"; mkdir -p "$SCRATCH"
    git worktree add --detach "$wt" "$c" >/dev/null 2>&1 || { echo "✗ worktree"; fail=1; wt=""; continue; }
    write_override
    if ! compose up -d --wait postgres >"$wt/.cache/up.log" 2>&1; then
        echo "✗ postgres for $PROJECT did not start:"; tail -n 3 "$wt/.cache/up.log" | sed 's/^/    /'
        fail=1; cleanup; wt=""; continue
    fi

    if ! run_tests .cache/bites-with.json $files; then
        echo "✗ red even WITH the fix — the test or the environment; investigate by hand"; fail=1; cleanup; wt=""; continue
    fi
    if ! git -C "$wt" diff "$c^" "$c" -- . "${TEST_SIDE[@]}" | git -C "$wt" apply -R; then
        echo "✗ the revert did not apply — check by hand"; fail=1; cleanup; wt=""; continue
    fi
    run_tests .cache/bites-without.json $files || true
    python3 - "$titles" "$wt/.cache/bites-without.json" <<'PY' || fail=1
import json, sys
titles = [t for t in sys.argv[1].split("\n") if t]
report = json.load(open(sys.argv[2], encoding="utf-8"))
status = {}
for file in report.get("testResults", []):
    for case in file.get("assertionResults", []):
        status.setdefault(case.get("title", ""), []).append(case.get("status"))
bad = False
for t in titles:
    kinds = status.get(t)
    if kinds is None:
        print(f"  ? NOT RUN          {t} — the file filter did not cover it"); bad = True
    elif all(k == "failed" for k in kinds):
        print(f"  ✓ BITES            {t}")
    else:
        print(f"  ✗ DOES NOT BITE    {t} ({', '.join(kinds)})"); bad = True
others = sum(1 for t, ks in status.items() if t not in titles and any(k == "failed" for k in ks))
if others:
    print(f"  ({others} older tests are red without the fix — expected when they guard it too)")
sys.exit(1 if bad else 0)
PY
    cleanup; wt=""
done
exit "$fail"
