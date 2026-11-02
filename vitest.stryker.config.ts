import { defineConfig } from "vitest/config";

/**
 * A dedicated Vitest config for Stryker's mutation testing (see stryker.config.json).
 *
 * It runs only the `packages/domain` tests — pure logic with no in-process Postgres and no
 * spawned processes — so mutation testing needs no database and is deterministic. It is not
 * picked up by `pnpm test`, which loads vitest.config.ts.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    name: "domain",
    include: ["packages/domain/test/**/*.test.{ts,tsx}"],
  },
});
