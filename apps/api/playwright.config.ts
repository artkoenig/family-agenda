import { defineConfig, devices } from "@playwright/test";

// Browser UI tests against a fake Application, without a database (ADR-0007).
export default defineConfig({
  testDir: "test/ui",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The app and its packages are compiled by tsx (see test/ui/support/serve.ts), not by Playwright,
  // whose transform would compile their JSX for React instead of Hono.
  build: { external: ["**/apps/api/src/**", "**/packages/*/src/**"] },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
