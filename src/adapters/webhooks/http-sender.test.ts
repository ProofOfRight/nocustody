// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxMessage } from "../../application/ports.ts";
import { HttpWebhookSender, isSpecialAddress, signWebhook } from "./http-sender.ts";

const SECRET = "s".repeat(40);
const message: OutboxMessage = {
  id: "1",
  eventId: "6f1c7c1e-1111-4222-8333-444455556666",
  type: "invoice.paid",
  aggregateId: "inv-1",
  occurredAt: new Date("2026-10-26T12:00:00Z"),
  payload: { amount: "10.010000", transferKey: "tron:nile/abc/0" },
  attempts: 0,
};

let received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
let status = 200;
let responseBody = "ok";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.statusCode = status;
    res.end(responseBody);
  });
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/nocustody?x=1`;
});
afterAll(() => {
  server.close();
});

const sender = (over: Partial<ConstructorParameters<typeof HttpWebhookSender>[0]> = {}) =>
  new HttpWebhookSender({
    url,
    secret: SECRET,
    allowPrivateNetworks: true,
    allowHttp: true,
    timeoutMs: 2_000,
    now: () => new Date("2026-10-26T12:00:05Z"),
    ...over,
  });

describe("webhook sender", () => {
  it("signs ts.event_id.body with the webhook secret and never sends the secret", async () => {
    received = [];
    status = 200;
    expect(await sender().send(message)).toEqual({ ok: true });
    const r = received[0];
    expect(r?.headers["x-event-id"]).toBe(message.eventId);
    const ts = String(Date.parse("2026-10-26T12:00:05Z") / 1000);
    expect(r?.headers["x-timestamp"]).toBe(ts);
    expect(r?.headers["x-signature"]).toBe(signWebhook(SECRET, ts, message.eventId, r?.body ?? ""));
    expect(JSON.parse(r?.body ?? "{}")).toEqual({
      id: message.eventId,
      type: "invoice.paid",
      created_at: "2026-10-26T12:00:00.000Z",
      data: { amount: "10.010000", transfer_key: "tron:nile/abc/0", object_id: "inv-1" },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("non-2xx is a retryable failure", async () => {
    status = 500;
    expect(await sender().send(message)).toEqual({ ok: false, error: "HTTP 500", retryable: true });
    status = 302;
    expect((await sender().send(message)).ok).toBe(false); // redirects are not followed
    status = 200;
  });

  it("an oversized response body is cut off and still yields a result", async () => {
    responseBody = "x".repeat(300_000);
    try {
      status = 200;
      expect(await sender().send(message)).toEqual({ ok: true });
      status = 503;
      expect(await sender().send(message)).toEqual({ ok: false, error: "HTTP 503", retryable: true });
    } finally {
      responseBody = "ok";
      status = 200;
    }
  });

  it("SSRF: private and special addresses are refused unless explicitly allowed", async () => {
    const r = await sender({ allowPrivateNetworks: false }).send(message);
    expect(r).toMatchObject({ ok: false, retryable: false });
    const viaDns = sender({
      url: "https://merchant.example/hook",
      allowPrivateNetworks: false,
      resolve: async () => [
        { address: "93.184.215.14", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    expect(await viaDns.send(message)).toMatchObject({ ok: false, retryable: false });
  });

  it("a resolver failure is retried; only the SSRF policy is final", async () => {
    const dnsDown = sender({
      url: "https://merchant.example/hook",
      allowPrivateNetworks: false,
      resolve: async () => {
        throw Object.assign(new Error("getaddrinfo EAI_AGAIN merchant.example"), { code: "EAI_AGAIN" });
      },
    });
    expect(await dnsDown.send(message)).toMatchObject({ ok: false, retryable: true });
    const noAnswer = sender({
      url: "https://merchant.example/hook",
      allowPrivateNetworks: false,
      resolve: async () => [],
    });
    expect(await noAnswer.send(message)).toMatchObject({ ok: false, retryable: true });
  });

  it("the deadline covers the whole attempt: a response that trickles bytes forever is cut off", async () => {
    // Node's socket `timeout` is an idle timeout; one byte every 150 ms keeps it alive for hours (0.2.1).
    const timers: NodeJS.Timeout[] = [];
    const trickle = createServer((_req, res) => {
      res.writeHead(200);
      timers.push(setInterval(() => res.write("x"), 150));
    });
    await new Promise<void>((r) => trickle.listen(0, "127.0.0.1", r));
    try {
      const port = (trickle.address() as AddressInfo).port;
      const started = Date.now();
      const r = await sender({ url: `http://127.0.0.1:${port}/hook`, timeoutMs: 600 }).send(message);
      expect(r).toEqual({ ok: false, error: "timeout", retryable: true });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const t of timers) clearInterval(t);
      trickle.closeAllConnections();
      trickle.close();
    }
  });

  it("classifies special addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.2.1", // TEST-NET-1
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "::a00:1", // IPv4-compatible 10.0.0.1
      "fd00::1",
      "fe80::1",
      "fec0::1",
      "100::1",
      "2001::1", // Teredo
      "2002:a00:1::1", // 6to4 of 10.0.0.1
      "64:ff9b::a00:1", // NAT64 well-known
      "64:ff9b:1::a00:1", // NAT64 local-use
      "::ffff:127.0.0.1",
      "::ffff:a00:1",
      "224.0.0.1",
    ]) {
      expect(isSpecialAddress(a), a).toBe(true);
    }
    for (const a of [
      "93.184.215.14",
      "1.1.1.1",
      "2606:4700:4700::1111",
      "2001:db8::1".replace("db8", "4860"),
    ])
      expect(isSpecialAddress(a), a).toBe(false);
  });

  it("refuses plain http, credentials in the URL and short secrets", () => {
    expect(() => sender({ allowHttp: false })).toThrow("https");
    expect(() => sender({ url: "https://u:p@merchant.example/h" })).toThrow("credentials");
    expect(() => sender({ secret: "short" })).toThrow("32");
  });
});

describe("shared signature vector (examples/php/test-vector.json)", () => {
  it("the PHP example and the gateway agree on the signature", () => {
    const v = JSON.parse(
      readFileSync(new URL("../../../examples/php/test-vector.json", import.meta.url), "utf8"),
    );
    expect(signWebhook(v.secret, v.timestamp, v.eventId, v.body)).toBe(v.signature);
  });
});
