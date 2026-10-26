#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Compare the phase 2 checklist (references/tests.md) with the tests and the code.

Run from the repository root:  python3 .claude/skills/project-audit/scripts/test_checklist.py

Checklist format: a line "- <scenario> — `<test file> :: <test title>`[, `…`]" or "- <scenario> — NO TEST (…)";
a group may carry "<!-- covers: path, path -->" (source modules the group covers) and
"<!-- skip: path — why -->" (modules deliberately outside the checklist). A test file is a unique suffix of
its repository path (`invoice.test.ts`, `tron/adapter.test.ts`); a title is the first argument of it()/test().

Prints:
  DEAD REFERENCE — the test file or title does not exist (exit code 1: the checklist lies);
  NO TEST        — scenarios without a test (phase 2 writes them);
  UNMENTIONED    — source modules under src/, scripts/, tools/ (tests, fixtures and fakes excluded) that are
                   in no covers/skip and are not named in the text — add a group or an item;
  UNREFERENCED   — test files the checklist never references.
The script checks that a test EXISTS, not that it fails when the code breaks — that is phase 3.
"""
import os
import re
import subprocess
import sys

CHECKLIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "references", "tests.md")
SOURCE_ROOTS = ("src", "scripts", "tools")
EXCLUDE = re.compile(r"\.test\.ts$|/fixtures/|/testing/|/test-fixtures\.ts$|\.sql$")
# Modifier captured: .skip and .todo titles exist but prove nothing, so a reference to one is reported as dead.
TITLE = re.compile(r"""^\s*(?:it|test)(?:\.(skip|only|todo|each|concurrent))?\((["'`])(.*?)\2""", re.M)
REF = re.compile(r"`([^`]+?\.test\.ts) :: ([^`]+)`")
ITEM = re.compile(r"^\s*- (.+?) — (.+)$")
COVERS = re.compile(r"<!--\s*covers:\s*(.*?)\s*-->", re.S)
SKIP = re.compile(r"<!--\s*skip:\s*(.*?)\s*-->", re.S)


def tracked(prefixes):
    out = subprocess.run(["git", "ls-files", *prefixes], check=True, capture_output=True, text=True).stdout
    return [f for f in out.split("\n") if f]


def resolve(suffix, candidates):
    """Repository paths among candidates that end with the suffix (at a path-segment boundary)."""
    return [c for c in candidates if c == suffix or c.endswith("/" + suffix)]


def main():
    text = open(CHECKLIST, encoding="utf-8").read()
    test_files = [f for f in tracked(SOURCE_ROOTS) if f.endswith(".test.ts")]
    titles, skipped = {}, {}
    for f in test_files:
        found = TITLE.findall(open(f, encoding="utf-8").read())
        titles[f] = {t for mod, _, t in found if mod not in ("skip", "todo")}
        skipped[f] = {t for mod, _, t in found if mod in ("skip", "todo")}
    sources = [f for f in tracked(SOURCE_ROOTS) if f.endswith(".ts") and not EXCLUDE.search(f)]

    dead, no_test, referenced = [], [], set()
    for n, line in enumerate(text.split("\n"), 1):
        m = ITEM.match(line)
        if not m:
            continue
        scenario, rest = m.group(1), m.group(2)
        refs = REF.findall(rest)
        if not refs:
            if rest.startswith("NO TEST"):
                no_test.append(f"{n}: {scenario}")
            continue
        for suffix, title in refs:
            found = resolve(suffix, test_files)
            if len(found) != 1:
                why = "no such test file" if not found else f"ambiguous suffix: {', '.join(found)}"
                dead.append(f"{n}: `{suffix} :: {title}` — {why}")
                continue
            path = found[0]
            if title in skipped[path]:
                dead.append(f"{n}: `{suffix} :: {title}` — the test is skipped (it.skip / it.todo) in {path}")
                continue
            if title not in titles[path]:
                dead.append(f"{n}: `{suffix} :: {title}` — no such test title in {path}")
                continue
            referenced.add(path)

    covered = set()
    for block in COVERS.findall(text) + [s.split("—")[0] for s in SKIP.findall(text)]:
        for item in re.split(r"[,\n]", block):
            item = item.strip()
            if not item:
                continue
            found = resolve(item, sources)
            if not found:
                dead.append(f"covers/skip: `{item}` — no such source module")
            covered.update(found)
    # A module counts as mentioned only with at least its last two path segments (tron/schemas.ts, not schemas.ts).
    unmentioned = [s for s in sources if s not in covered and "/".join(s.split("/")[-2:]) not in text]
    unreferenced = [f for f in test_files if f not in referenced]

    def show(label, items):
        print(f"{label} ({len(items)}):")
        for i in items:
            print(f"  {i}")

    show("DEAD REFERENCE", dead)
    show("NO TEST", no_test)
    show("UNMENTIONED", unmentioned)
    show("UNREFERENCED", unreferenced)
    print(f"\ntest files: {len(test_files)}, referenced: {len(referenced)}, titles: {sum(len(t) for t in titles.values())}, "
          f"source modules: {len(sources)}, covered: {len(covered & set(sources))}")
    sys.exit(1 if dead else 0)


if __name__ == "__main__":
    os.chdir(subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True,
                            text=True).stdout.strip())
    main()
