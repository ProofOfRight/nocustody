// SPDX-License-Identifier: Apache-2.0
// API keys: "nck_<12 hex id>_<43 char base64url secret>". The 256-bit secret is shown once; only its SHA-256 is
// stored (a slow password hash adds nothing for a uniformly random 256-bit secret). Comparison is constant-time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyRecord, ApiKeyRepository, ApiScope } from "../../application/ports.ts";

export const ALL_SCOPES: readonly ApiScope[] = ["invoices:read", "invoices:write", "quotes:read"];
const TOKEN = /^nck_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function newApiKey(
  name: string,
  scopes: readonly ApiScope[],
): { record: ApiKeyRecord; token: string } {
  if (!/^[\w .-]{1,64}$/.test(name))
    throw new Error("key name: 1-64 letters, digits, space, dot, dash, underscore");
  if (scopes.length === 0 || scopes.some((s) => !ALL_SCOPES.includes(s))) {
    throw new Error(`scopes must be a non-empty subset of ${ALL_SCOPES.join(", ")}`);
  }
  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    record: { id, name, secretSha256: sha256(secret), scopes: [...new Set(scopes)], revokedAt: null },
    token: `nck_${id}_${secret}`,
  };
}

/** Returns the key if the token is valid and not revoked; null otherwise (never says which part was wrong). */
export async function authenticate(token: string, keys: ApiKeyRepository): Promise<ApiKeyRecord | null> {
  const m = TOKEN.exec(token);
  if (!m?.[1] || !m[2]) return null;
  const record = await keys.findById(m[1]);
  const expected = Buffer.from(record?.secretSha256 ?? "0".repeat(64), "hex");
  const actual = Buffer.from(sha256(m[2]), "hex");
  const ok = timingSafeEqual(expected, actual);
  return ok && record && record.revokedAt === null ? record : null;
}
