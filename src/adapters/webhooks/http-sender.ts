// SPDX-License-Identifier: Apache-2.0
// Webhook delivery over node:http(s), no dependencies.
//  - body: {"id","type","created_at","data"}; headers X-Event-Id, X-Timestamp, X-Signature: v1=<hex HMAC-SHA256 of
//    `${timestamp}.${event_id}.${body}` with the webhook secret>. The secret is never sent.
//  - SSRF protection: the host is resolved once, every resolved address is checked against private, loopback,
//    link-local and other special ranges, and the connection goes to the checked address (no DNS rebinding).
//    Private networks and plain http are allowed only when configured explicitly. Redirects are not followed.
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { DeliveryResult, OutboxMessage, WebhookSender } from "../../application/ports.ts";

export interface WebhookOptions {
  readonly url: string;
  readonly secret: string;
  readonly allowPrivateNetworks: boolean;
  readonly allowHttp: boolean;
  readonly timeoutMs: number;
  readonly now?: () => Date;
  readonly resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

const SPECIAL = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  SPECIAL.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
] as const) {
  SPECIAL.addSubnet(net, prefix, "ipv6");
}

/** Private, loopback, link-local, multicast, reserved — anything that is not a public unicast address. */
export function isSpecialAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return SPECIAL.check(mapped[1], "ipv4");
  const family = isIP(address);
  if (family === 4) return SPECIAL.check(address, "ipv4");
  if (family === 6) return SPECIAL.check(address, "ipv6");
  return true;
}

export function signWebhook(secret: string, timestamp: string, eventId: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`).digest("hex")}`;
}

export class HttpWebhookSender implements WebhookSender {
  readonly #o: WebhookOptions;
  readonly #url: URL;

  constructor(o: WebhookOptions) {
    const url = new URL(o.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && o.allowHttp)) {
      throw new Error("webhook URL must use https (set allowHttp to permit http on a trusted network)");
    }
    if (url.username || url.password) throw new Error("webhook URL must not contain credentials");
    if (o.secret.length < 32) throw new Error("webhook secret must be at least 32 characters");
    this.#o = o;
    this.#url = url;
  }

  async send(m: OutboxMessage): Promise<DeliveryResult> {
    const host = this.#url.hostname.replace(/^\[|\]$/g, "");
    let address: string;
    try {
      address = await this.#safeAddress(host);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: false };
    }
    const body = JSON.stringify({
      id: m.eventId,
      type: m.type,
      created_at: m.occurredAt.toISOString(),
      data: { ...m.payload, object_id: m.aggregateId },
    });
    const timestamp = String(Math.floor((this.#o.now?.() ?? new Date()).getTime() / 1000));
    const headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "user-agent": "nocustody-webhooks/1",
      "x-event-id": m.eventId,
      "x-timestamp": timestamp,
      "x-signature": signWebhook(this.#o.secret, timestamp, m.eventId, body),
    };
    return new Promise<DeliveryResult>((resolve) => {
      const lib = this.#url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          protocol: this.#url.protocol,
          host: address, // the checked address: no second DNS resolution
          servername: isIP(host) ? undefined : host, // TLS SNI and certificate check use the real host name
          port: this.#url.port || undefined,
          path: `${this.#url.pathname}${this.#url.search}`,
          method: "POST",
          headers: { ...headers, host: this.#url.host },
          timeout: this.#o.timeoutMs,
        },
        (res) => {
          let read = 0;
          res.on("data", (chunk: Buffer) => {
            read += chunk.length;
            if (read > 65_536) res.destroy();
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            resolve(
              status >= 200 && status < 300
                ? { ok: true }
                : { ok: false, error: `HTTP ${status}`, retryable: true },
            );
          });
          res.on("error", () => resolve({ ok: false, error: "response error", retryable: true }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ ok: false, error: e.message, retryable: true }));
      req.end(body);
    });
  }

  async #safeAddress(host: string): Promise<string> {
    const resolved = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await (this.#o.resolve ?? ((h: string) => dnsLookup(h, { all: true })))(host);
    if (resolved.length === 0) throw new Error(`webhook host ${host} does not resolve`);
    if (this.#o.allowPrivateNetworks) return resolved[0]?.address ?? "";
    const bad = resolved.filter((r) => isSpecialAddress(r.address));
    if (bad.length > 0) {
      throw new Error(
        `webhook host ${host} resolves to a private or special address; set allowPrivateNetworks to permit it`,
      );
    }
    return resolved[0]?.address ?? "";
  }
}
