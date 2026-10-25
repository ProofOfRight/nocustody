// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["**/*.int.test.ts"],
        },
      },
      // Integration tests need PostgreSQL (TEST_DATABASE_URL); run them with `npm run test:int`.
      { test: { name: "integration", include: ["src/**/*.int.test.ts"], fileParallelism: false } },
    ],
  },
});
