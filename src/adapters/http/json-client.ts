// SPDX-License-Identifier: Apache-2.0
// Minimal HTTPS JSON client for blockchain providers: https only, no redirects, never leaves the configured host,
// timeout, response size limit, schema validation, client-side rate limit, retries with exponential backoff and
// jitter. The API key is sent only in its header.
import { randomInt } from "node:crypto";
import type { z } from "zod";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  /** Header that carries the API key, e.g. TRON-PRO-API-KEY (TronGrid) or X-API-Key (toncenter). */
  readonly apiKeyHeader?: string;
  /** Minimum interval between requests (provider rate limit without a key). */
  readonly minIntervalMs?: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly fetch?: FetchFn;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
  }
}

/** The response exceeded maxResponseBytes; a caller that pages can ask again for fewer rows. */
export class ResponseTooLargeError extends ProviderError {
  constructor(path: string) {
    super(`${path}: response too large`, false);
    this.name = "ResponseTooLargeError";
  }
}

const RETRY_STATUS = new Set([403, 408, 429, 500, 502, 503, 504]);

export class JsonHttpClient {
  readonly #base: URL;
  readonly #o: Required<Omit<HttpOptions, "apiKey">> & { apiKey: string | undefined };
  #next = 0;

  constructor(o: HttpOptions) {
    const base = new URL(o.baseUrl);
    if (base.protocol !== "https:") throw new Error("provider URL must use https");
    this.#base = base;
    this.#o = {
      apiKeyHeader: "X-API-Key",
      minIntervalMs: 0,
      maxAttempts: 4,
      baseDelayMs: 500,
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...o,
      apiKey: o.apiKey,
    };
  }

  async get<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, this.#base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return this.#request(url, { method: "GET" }, schema);
  }

  async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.#request(
      new URL(path, this.#base),
      { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      schema,
    );
  }

  async #request<T>(url: URL, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    if (url.origin !== this.#base.origin)
      throw new Error("refusing to call a host outside the configured provider");
    let last: ProviderError | null = null;
    for (let attempt = 1; attempt <= this.#o.maxAttempts; attempt++) {
      try {
        return await this.#once(url, init, schema);
      } catch (e) {
        last =
          e instanceof ProviderError
            ? e
            : new ProviderError(e instanceof Error ? e.message : String(e), true);
        if (!last.retryable || attempt === this.#o.maxAttempts) break;
        const cap = this.#o.baseDelayMs * 2 ** (attempt - 1);
        await this.#o.sleep(cap / 2 + randomInt(Math.max(1, Math.floor(cap / 2))));
      }
    }
    throw last ?? new ProviderError("request failed", true);
  }

  async #throttle(): Promise<void> {
    if (this.#o.minIntervalMs <= 0) return;
    const now = Date.now();
    const wait = this.#next - now;
    this.#next = Math.max(now, this.#next) + this.#o.minIntervalMs;
    if (wait > 0) await this.#o.sleep(wait);
  }

  async #once<T>(url: URL, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    await this.#throttle();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.#o.apiKey) headers.set(this.#o.apiKeyHeader, this.#o.apiKey);
    let res: Response;
    try {
      res = await this.#o.fetch(url.toString(), {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`${url.pathname}: ${e instanceof Error ? e.message : e}`, true);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError(
        `${url.pathname}: HTTP ${res.status}`,
        RETRY_STATUS.has(res.status),
        res.status,
      );
    }
    const text = await this.#readLimited(res, url.pathname);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError(`${url.pathname}: response is not JSON`, false);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProviderError(
        `${url.pathname}: unexpected response (${issue?.path.join(".")}: ${issue?.message})`,
        false,
      );
    }
    return parsed.data;
  }

  async #readLimited(res: Response, path: string): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.#o.maxResponseBytes) {
      await res.body?.cancel();
      throw new ResponseTooLargeError(path);
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.#o.maxResponseBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(path);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
