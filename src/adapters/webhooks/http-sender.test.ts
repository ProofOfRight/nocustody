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
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.statusCode = status;
    res.end("ok");
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

  it("classifies special addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "224.0.0.1",
    ]) {
      expect(isSpecialAddress(a)).toBe(true);
    }
    for (const a of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isSpecialAddress(a)).toBe(false);
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
