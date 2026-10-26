// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { runCanary } from "./canary.ts";

const input = {
  apiUrl: "https://pay.example.org/",
  apiKey: "nck_x",
  asset: "usdt-tron",
  amount: "1",
  currency: "USDT",
  expected: ["TGood1", "TGood2"],
  now: new Date("2026-10-26T12:00:00Z"),
};
const api = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("address canary", () => {
  it("passes when the shown address is expected", async () => {
    expect(await runCanary(input, api(201, { id: "i1", payment: { address: "TGood2" } }))).toEqual({
      status: "ok",
      address: "TGood2",
      invoiceId: "i1",
    });
  });

  it("fails loudly when the gateway shows an unexpected address", async () => {
    expect((await runCanary(input, api(201, { id: "i1", payment: { address: "TAttacker" } }))).status).toBe(
      "unexpected_address",
    );
  });

  it("reports when it cannot check", async () => {
    expect((await runCanary(input, api(503, {}))).status).toBe("error");
    expect((await runCanary(input, api(201, {}))).status).toBe("error");
  });
});
