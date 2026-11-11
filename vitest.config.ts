import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "packages",
          include: ["{packages,apps,tools}/*/test/**/*.test.{ts,tsx}"],
          // The *.image.test.ts files need the tools the image ships, and run inside it: vitest.image.config.ts.
          exclude: ["apps/api/test/**", "tools/preview/test/seed.test.ts", "**/*.image.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "api",
          include: ["apps/api/test/**/*.test.{ts,tsx}", "tools/preview/test/seed.test.ts"],
          // Migrates an in-process Postgres once, which every test database starts from.
          globalSetup: ["apps/api/test/support/postgres-snapshot.ts"],
          // The test files of a worker share its in-process Postgres databases, which take a
          // while to load, and the modules they import; each test boots an Instance of its own.
          isolate: false,
        },
      },
    ],
  },
});
