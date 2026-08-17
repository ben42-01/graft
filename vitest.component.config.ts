import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Component tests — jsdom + @testing-library/react (GRAFT-11.4). Sits
 * alongside `vitest.config.ts` (node, `*.test.ts`) the way
 * `vitest.integration.config.ts` does — environment is config-time in
 * Vitest, not a runtime flag. See issue #40's Context for why jsdom/RTL are
 * new to this repo.
 */
export default defineConfig({
  // tsconfig.json's `jsx: "preserve"` is for Next's SWC; esbuild needs this
  // explicit or falls back to the classic transform ("React is not defined").
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.component.ts"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
