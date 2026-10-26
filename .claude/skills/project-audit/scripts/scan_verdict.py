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
import subprocess
import sys

MAX_WHY = 120  # the "why" column is echoed into the agent's context: plain, short text only


def norm(text):
    return " ".join(text.split())


def baseline_at_last_audit(path):
    """Rows of scan.tsv as of the last `audit:` commit, or None when there is none (first audit)."""
    try:
        log = subprocess.run(["git", "log", "--format=%H %s", "main"], check=True, capture_output=True, text=True).stdout
        base = next((line.split(" ", 1)[0] for line in log.splitlines() if re.match(r"^[0-9a-f]+ audit(:|\()", line)), None)
        if not base:
            return None
        shown = subprocess.run(["git", "show", f"{base}:{path}"], check=True, capture_output=True, text=True).stdout
        return set(shown.splitlines())
    except (subprocess.CalledProcessError, OSError):
        return None


def main():
    section, path = sys.argv[1], sys.argv[2]
    known = {}
    previous = baseline_at_last_audit(path)
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            if not raw.strip() or raw.startswith("#"):
                continue
            cols = raw.rstrip("\n").split("\t")
            if len(cols) < 5:
                sys.exit(f"{path}: 5 tab-separated columns expected: {raw[:80]}")
            if cols[0] == section:
                why = re.sub(r"[^\x20-\x7e]", "?", cols[3])[:MAX_WHY]
                # A row added since the last audit was not reviewed by an audit: a pull request could suppress its
                # own finding this way. Print it as new, with the claimed reason for the reviewer.
                fresh = previous is not None and raw.rstrip("\n") not in previous
                known[(cols[1], norm(cols[2]))] = (why, cols[4], fresh)
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
            why, date, fresh = known[key]
            if fresh:
                print(f"  NEW (baseline row added since the last audit, claims: {why}): {line}")
            else:
                print(f"  reviewed ({why}, {date}): {line}")
        else:
            print(f"  NEW: {line}")
    if count == 0:
        print("  -- none")
    for key in known.keys() - seen:
        print(f"  stale (no such candidate any more — delete from scan.tsv): {section}\t{key[0]}\t{key[1]}")


if __name__ == "__main__":
    main()
