#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Mark the candidates of security_scan.sh against the baseline baseline/scan.tsv.

Called by security_scan.sh:  <candidates> | python3 scan_verdict.py <section> <scan.tsv>

stdin — the lines of one section: "file:line:text" (git grep -n) or free text (route tables, diffs).
The key is (section, file, text without the line number, whitespace collapsed), so edits higher up in a
file do not invalidate it. Prints "reviewed (why, date)" or "NEW" per line and, at the end, the baseline
entries of this section for which no candidate was found ("stale" — delete them from scan.tsv).
"""
import re
import sys


def norm(text):
    return " ".join(text.split())


def main():
    section, path = sys.argv[1], sys.argv[2]
    known = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            if not raw.strip() or raw.startswith("#"):
                continue
            cols = raw.rstrip("\n").split("\t")
            if len(cols) < 5:
                sys.exit(f"{path}: 5 tab-separated columns expected: {raw[:80]}")
            if cols[0] == section:
                known[(cols[1], norm(cols[2]))] = (cols[3], cols[4])
    seen = set()
    count = 0
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        count += 1
        m = re.match(r"^([^:\s]+):(\d+):(.*)$", line)
        key = (m.group(1), norm(m.group(3))) if m else ("", norm(line))
        if key in known:
            seen.add(key)
            print(f"  reviewed ({known[key][0]}, {known[key][1]}): {line}")
        else:
            print(f"  NEW: {line}")
    if count == 0:
        print("  -- none")
    for key in known.keys() - seen:
        print(f"  stale (no such candidate any more — delete from scan.tsv): {section}\t{key[0]}\t{key[1]}")


if __name__ == "__main__":
    main()
