import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts", "spikes/**/*.test.ts"],
    environment: "node",
    // The fixture smoke test shells out to git; give it headroom on cold caches.
    testTimeout: 30_000,
  },
});
