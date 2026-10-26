import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/test/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
