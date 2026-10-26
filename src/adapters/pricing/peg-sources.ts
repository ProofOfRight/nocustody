// SPDX-License-Identifier: Apache-2.0
// Public USDT/USD prices for depeg protection. Used only when the operator enables depeg protection in config;
// otherwise the gateway makes no requests to exchanges.
import { z } from "zod";
import type { PegPriceSource } from "../../application/ports.ts";
import { type Rational, rationalFromDecimal } from "../../domain/rational.ts";
import type { JsonHttpClient } from "../http/json-client.ts";

const price = z.string().regex(/^\d{1,6}\.\d{1,12}$/);

/** Kraken GET /0/public/Ticker?pair=USDTUSD — last trade price `result.USDTZUSD.c[0]`. */
export class KrakenUsdtUsd implements PegPriceSource {
  readonly name = "kraken";
  readonly #client: JsonHttpClient;

  constructor(client: JsonHttpClient) {
    this.#client = client;
  }

  async price(): Promise<Rational> {
    const r = await this.#client.get(
      "/0/public/Ticker",
      { pair: "USDTUSD" },
      z.object({
        error: z.array(z.string()).length(0),
        result: z.object({ USDTZUSD: z.object({ c: z.tuple([price, z.string()]) }) }),
      }),
    );
    return rationalFromDecimal(r.result.USDTZUSD.c[0]);
  }
}

/** Coinbase Exchange GET /products/USDT-USD/ticker — `price`. */
export class CoinbaseUsdtUsd implements PegPriceSource {
  readonly name = "coinbase";
  readonly #client: JsonHttpClient;

  constructor(client: JsonHttpClient) {
    this.#client = client;
  }

  async price(): Promise<Rational> {
    const r = await this.#client.get("/products/USDT-USD/ticker", {}, z.object({ price }));
    return rationalFromDecimal(r.price);
  }
}
