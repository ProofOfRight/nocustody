// SPDX-License-Identifier: Apache-2.0
import { pino } from "pino";

/** Structured JSON logs; anything that may carry a secret is redacted. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "apiKey",
      "*.apiKey",
      "headers",
      "*.headers",
      "password",
      "*.password",
      "databaseUrl",
      "*.databaseUrl",
    ],
    censor: "[redacted]",
  },
});
