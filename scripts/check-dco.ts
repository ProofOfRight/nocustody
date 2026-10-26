// SPDX-License-Identifier: Apache-2.0
// Developer Certificate of Origin check: every commit in the given range must carry
// "Signed-off-by: <author name> <author email>" (Dependabot excepted). Usage: node scripts/check-dco.ts <base>..<head>
import { execFileSync } from "node:child_process";

export interface CommitInfo {
  sha: string;
  author: string;
  signoffs: string[];
}

/**
 * Dependency bumps by Dependabot carry no authored content to certify. Matching is by author identity only, so a
 * contributor could pose as the bot to skip the sign-off; such a commit still needs code owner review to merge.
 */
export const BOT_AUTHORS: ReadonlySet<string> = new Set([
  "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
]);

export function missingSignoff(commits: readonly CommitInfo[]): CommitInfo[] {
  return commits.filter((c) => !BOT_AUTHORS.has(c.author) && !c.signoffs.includes(c.author));
}

function readCommits(range: string): CommitInfo[] {
  const SEP = "\u001e";
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `--format=%H%n%an <%ae>%n%(trailers:key=Signed-off-by,valueonly)${SEP}`, range],
    { encoding: "utf8" },
  );
  return out
    .split(SEP)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [sha = "", author = "", ...signoffs] = block.split("\n").map((l) => l.trim());
      return { sha, author, signoffs: signoffs.filter(Boolean) };
    });
}

function main(): void {
  const range = process.argv[2];
  if (!range) {
    console.error("usage: node scripts/check-dco.ts <base>..<head>");
    process.exit(2);
  }
  const commits = readCommits(range);
  const bad = missingSignoff(commits);
  if (bad.length > 0) {
    for (const c of bad) console.error(`${c.sha.slice(0, 12)}: missing "Signed-off-by: ${c.author}"`);
    console.error("Sign off your commits with `git commit -s` (see CONTRIBUTING.md).");
    process.exit(1);
  }
  console.log(`DCO ok (${commits.length} commits)`);
}

if (import.meta.main) main();
