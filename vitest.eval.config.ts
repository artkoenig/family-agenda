import { defineConfig } from "vitest/config";

/**
 * A dedicated Vitest config for the evals, which read example messages with a real LLM (`*.eval.ts`).
 * They need an LLM server and take minutes, so `pnpm test` and `pnpm check` do not pick them up.
 */
export default defineConfig({
  test: {
    name: "eval",
    include: ["packages/*/test/**/*.eval.ts"],
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 30_000,
    // One message at a time: a local server answers one anyway, and waiting would count against the timeout.
    fileParallelism: false,
  },
});
