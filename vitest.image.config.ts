import { defineConfig } from "vitest/config";

/**
 * A dedicated Vitest config for the tests that call the command-line tools the image ships, such
 * as poppler and Tesseract (`*.image.test.ts`). CI runs them inside the built image, through
 * .github/container-ci/image-tests.sh, so they test the tools an Instance really runs. They are
 * not picked up by `pnpm test` or `pnpm check`, which load vitest.config.ts.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    name: "image",
    include: ["{packages,apps,tools}/*/test/**/*.image.test.{ts,tsx}"],
  },
});
