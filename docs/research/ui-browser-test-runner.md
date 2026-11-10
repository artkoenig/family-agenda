# Browser test runner for the htmx UI

Research for issue #337. Question: Playwright Test vs Vitest browser mode (Playwright provider) vs other, for the server-rendered Hono JSX + htmx UI in `apps/api/src/http/` (inline scripts in `layout.tsx`). Constraint: tests run against mocks only (no containers, DB, real network).

## Recommendation

Use **Playwright Test (`@playwright/test`)** as a separate workspace project with its own config and CI job. Start the Hono app in-process (or via `webServer`) with mocked ports/adapters, and use `page.route()` to delay, fail or fulfill htmx requests. Keep it out of `vitest.config.ts` so `pnpm crap` and Stryker never see it.

## Comparison

| Criterion | Playwright Test | Vitest browser mode (Playwright provider) |
|---|---|---|
| Model | Drives a real browser against a URL; `page.goto()` loads full server-rendered documents [1][3] | Runs *test files inside* a browser iframe served by Vite; built for component/module tests [5] |
| htmx pages + inline scripts | Natural fit: the page is the real HTML from Hono, inline scripts and htmx run as in production | Poor fit: the test runs in Vitest's own page, not the app's document; full-page navigation to the app is not the model [5] |
| Network interception / delays | `page.route()` + `route.fulfill()`/`route.abort()`/`route.continue()`; delay by awaiting before fulfilling [2][4] | No first-class page-routing API in tests; request mocking guide points to MSW-style mocking of the test page [5] |
| pnpm / Node 22 / Vitest 5 | Independent of Vitest; supports current Node LTS; installs via `pnpm add -D @playwright/test` + `pnpm exec playwright install --with-deps chromium` [1][6] | Requires `@vitest/browser-playwright` matching Vitest 5; tied to the Vitest version used by Stryker's runner |
| Headless CI, separate job | Headless by default; official CI guide and GitHub Actions example [6] | Possible (`headless: true`), but shares Vitest config/projects |
| Out of `pnpm crap` / Stryker | Automatic: different runner, different config; just keep specs outside `*/test/**/*.test.{ts,tsx}` globs (e.g. `apps/api/e2e/*.spec.ts`) | Needs explicit exclusion in `vitest.config.ts` and `vitest.stryker.config.ts`; coverage from browser mode could leak into the CRAP report |

## Notes for implementation

- Mocks-only: boot the Instance with in-memory fakes in a Playwright `globalSetup` or `webServer.command` (`webServer` waits on `url`, `reuseExistingServer: !process.env.CI`) [3]. No DB container needed if the composition root accepts fake adapters.
- Loading states: `await page.route('**/some-htmx-endpoint', async r => { await gate; await r.fulfill({...}) })` lets the test assert the `htmx-request` indicator before releasing. Error states: `route.fulfill({ status: 500 })` or `route.abort()` [4].
- Only route requests the browser makes; server-side calls inside Hono are mocked at the adapter level, not via `page.route`.
- Install only Chromium in CI to keep the job fast.

## Other options considered

- WebdriverIO / Cypress: heavier, no advantage for this stack; Cypress has its own runner and Electron/Chrome dependency.
- jsdom/happy-dom in Vitest: no real layout or real htmx event loop timing; would also feed coverage into `pnpm crap`.

## Sources

1. Playwright, Installation — https://playwright.dev/docs/intro
2. Playwright, Network / Mock APIs — https://playwright.dev/docs/network , https://playwright.dev/docs/mock
3. Playwright, Web server — https://playwright.dev/docs/test-webserver
4. Playwright, class Route — https://playwright.dev/docs/api/class-route
5. Vitest, Browser Mode guide (providers `preview`/`playwright`/`webdriverio`, iframe model, mocking requests) — https://vitest.dev/guide/browser/
6. Playwright, Setting up CI — https://playwright.dev/docs/ci
