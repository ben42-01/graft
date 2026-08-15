import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/** Unit tests — no database, no network. Fast enough to run on every save. */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      // docs/BACKEND.md §7.3 — "Coverage gate 80% on services". Scoped to the
      // service layer deliberately: pure data (tiers.ts) and thin driver
      // wrappers (mongo.ts, redis.ts) are not what the gate is protecting.
      include: ["src/server/services/**"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
