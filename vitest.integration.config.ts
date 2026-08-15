import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Integration tests — repositories, service flows and tenant isolation, run
 * against the QA docker stack (docs/BACKEND.md §7.1). Longer timeouts and no
 * parallelism, because they share one database.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.integration.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
