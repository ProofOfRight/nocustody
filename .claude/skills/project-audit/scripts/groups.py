#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Split the code base into groups for the parallel phases 1 and 4 of the project audit.

Run from the repository root:  python3 .claude/skills/project-audit/scripts/groups.py [group] [--tests]

Without an argument: a summary (groups, files, lines) and the files that match no group (UNASSIGNED, exit
code 1 — add a rule below first). With a group name: its files, one per line (what a subagent receives).
Test files (*.test.ts) are listed only with --tests; fixtures and in-memory fakes stay with their group.
"""
import os
import re
import subprocess
import sys

# Order matters: the first matching rule wins.
GROUPS = {
    # Pure TypeScript: value objects, the Invoice aggregate, policies, slots, memos, events.
    "domain": r"^src/domain/",
    # Use cases, ports, strategies, the asset catalogue, in-memory fakes.
    "application": r"^src/application/",
    # Everything that talks to the outside world as a client: chain adapters, the JSON client,
    # second sources, peg sources, AML providers, alert sinks.
    "chains": r"^src/adapters/(chains|http|pricing|aml|alerts)/|^src/adapters/ops-adapters\.test\.ts$",
    # Merchant-facing edge: the REST API, API keys, the payment page, webhook delivery.
    "edge": r"^src/adapters/(api|webhooks)/",
    # Persistence, system adapters and the composition root: config, container, CLI, integrity, logger.
    "platform": r"^src/adapters/(persistence|system)/|^src/app/",
    # Repository checks, e2e scenarios, SBOM, the canary.
    "tooling": r"^scripts/|^tools/",
    # Build, deployment and CI (read by the infrastructure security agent together with `tooling`).
    "infra": r"^(Dockerfile|\.dockerignore|compose\.yaml|Makefile|\.npmrc|package\.json|package-lock\.json|"
             r"biome\.json|tsconfig[a-z.]*\.json|vitest\.config\.ts|\.dependency-cruiser\.mjs)$|"
             r"^(deploy|docker|\.github|\.claude)/",
}
# Tracked files that are not reviewed by group: documentation (read by the main session), examples, licences.
IGNORED = r"^(docs|examples)/|\.md$|^(LICENSE|NOTICE|CHANGELOG\.md|\.gitignore)$"
TEST = re.compile(r"\.test\.ts$")


def tracked_files():
    out = subprocess.run(["git", "ls-files"], check=True, capture_output=True, text=True).stdout
    return [f for f in out.split("\n") if f]


def group_of(path):
    for name, pattern in GROUPS.items():
        if re.search(pattern, path):
            return name
    return None


def line_count(path):
    try:
        with open(path, "rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return 0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    with_tests = "--tests" in sys.argv
    files = tracked_files()
    if args:
        name = args[0]
        if name not in GROUPS:
            sys.exit(f"unknown group {name}; known: {', '.join(GROUPS)}")
        for f in files:
            if group_of(f) == name and (with_tests or not TEST.search(f)):
                print(f)
        return
    counts = {name: [0, 0, 0] for name in GROUPS}  # files, lines, test files
    unassigned = []
    for f in files:
        if re.search(IGNORED, f):
            continue
        name = group_of(f)
        if name is None:
            unassigned.append(f)
            continue
        if TEST.search(f):
            counts[name][2] += 1
        else:
            counts[name][0] += 1
            counts[name][1] += line_count(f)
    print(f"{'group':<12}{'files':>6}{'lines':>8}{'tests':>7}")
    for name, (n, lines, tests) in counts.items():
        print(f"{name:<12}{n:>6}{lines:>8}{tests:>7}")
    if unassigned:
        print("\nUNASSIGNED (add a rule to GROUPS in this script):")
        for f in unassigned:
            print(f"  {f}")
        sys.exit(1)


if __name__ == "__main__":
    os.chdir(subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True,
                            text=True).stdout.strip())
    main()
