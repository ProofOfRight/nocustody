// SPDX-License-Identifier: Apache-2.0
// Shared fixtures for domain tests.
import { type Asset, defineAsset } from "./asset.ts";
import { networkId } from "./network.ts";

export const TRON = networkId("tron:mainnet");

export const USDT_TRON: Asset = defineAsset({
  id: "usdt-tron",
  network: TRON,
  kind: "token",
  contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  decimals: 6,
  symbol: "USDT",
});
