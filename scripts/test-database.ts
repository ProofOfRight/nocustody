// SPDX-License-Identifier: Apache-2.0
// The e2e replay scripts reset the schema of the database they are given. Only a database whose name ends in
// "_test" is ever accepted, so a mis-set TEST_DATABASE_URL cannot wipe a real one.
export function requireTestDatabase(url: string | undefined, envName = "TEST_DATABASE_URL"): string {
  if (!url) throw new Error(`${envName} is required`);
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new Error(`${envName} is not a URL`);
  }
  if (!name.endsWith("_test")) {
    throw new Error(
      `${envName} must point at a database whose name ends in _test (got "${name}"): its schema is reset`,
    );
  }
  return url;
}
