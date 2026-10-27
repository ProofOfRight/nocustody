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

  it("checks every form a payer could see: address_display and the wallet URI, not only payment.address", async () => {
    const honest = {
      id: "i1",
      payment: { address: "TGood2", address_display: "TGood2", uri: "tron:TGood2?amount=1" },
    };
    expect((await runCanary(input, api(201, honest))).status).toBe("ok");
    const display = { id: "i1", payment: { address: "TGood2", address_display: "TAttacker", uri: null } };
    expect(await runCanary(input, api(201, display))).toMatchObject({
      status: "unexpected_address",
      address: "address_display: TAttacker",
    });
    const uri = {
      id: "i1",
      payment: { address: "TGood2", address_display: "TGood2", uri: "tron:TAttacker?amount=1" },
    };
    expect((await runCanary(input, api(201, uri))).status).toBe("unexpected_address");
    // TON: the raw and the user-friendly form are both listed by the operator
    const ton = {
      ...input,
      expected: [
        "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0",
        "UQAya8rx8lLKnjRY_nM0hWav6AX3xbQDOSdyYLyy_IdisFZt",
      ],
    };
    const tonBody = {
      id: "i2",
      payment: {
        address: "0:326bcaf1f252ca9e3458fe73348566afe805f7c5b40339277260bcb2fc8762b0",
        address_display: "UQAya8rx8lLKnjRY_nM0hWav6AX3xbQDOSdyYLyy_IdisFZt",
        uri: "ton://transfer/UQAya8rx8lLKnjRY_nM0hWav6AX3xbQDOSdyYLyy_IdisFZt?amount=1",
      },
    };
    expect((await runCanary(ton, api(201, tonBody))).status).toBe("ok");
  });

  it("uses a random order id and refuses plain http unless allowed", async () => {
    const orders: string[] = [];
    const capture = (async (_url: string, init: RequestInit) => {
      orders.push(JSON.parse(String(init.body)).merchant_order_id);
      return new Response(JSON.stringify({ id: "i1", payment: { address: "TGood1" } }), { status: 201 });
    }) as unknown as typeof fetch;
    await runCanary(input, capture);
    await runCanary(input, capture);
    expect(orders[0]).not.toBe(orders[1]);
    expect(orders[0]).toMatch(/^canary-[0-9a-f-]{36}$/);
    expect(await runCanary({ ...input, apiUrl: "http://pay.example.org" }, capture)).toMatchObject({
      status: "error",
    });
    expect(
      (await runCanary({ ...input, apiUrl: "http://pay.example.org", allowHttp: true }, capture)).status,
    ).toBe("ok");
  });

  it("reports when it cannot check", async () => {
    expect((await runCanary(input, api(503, {}))).status).toBe("error");
    expect((await runCanary(input, api(201, {}))).status).toBe("error");
  });
});
