---
status: accepted
---

# Browser UI tests run the real HTTP app against a fake Application, without a database

The HTML-level tests in `apps/api/test/http/` check what the server renders. They cannot check what the browser does with it: htmx swaps, lazy fragments with their loading, error and retry states, dialogs across Back/Forward, and the inline scripts in `layout.tsx`. We add browser tests with Playwright Test. They run the real `createHttpApp` against a fake `Application` instead of the composition root. There are no containers, no database (not even the in-process Postgres) and no real network, so every loading and error state can be produced deterministically. The decisions were made in [Introduce browser-based UI testing](https://github.com/artkoenig/family-agenda/issues/336).

## The seam and the fakes

- **The seam is the `Application` object.** `createHttpApp(application, options)` depends on nothing else, so rendering, routing, htmx attributes and inline scripts are all real. Only the use cases behind them are faked.
- **Fakes are strict.** The fake `Application` is a typed proxy that throws `not faked: <access>.<method>` for any call a test did not stub. Stateful in-memory fakes exist only where a flow spans several requests, such as adding a Source and then seeing it in the list.
- **Two kinds of failure, two sources.** Transport failures (a slow response, a 500, an aborted request) come from Playwright's `page.route`, which holds a request back and then fulfills, fails or aborts it. Domain failures (for example a plugin query that fails) come from the fake, which returns `{ ok: false }` or throws, so the real error fragment is asserted.
- **The security layer is not exercised.** Tests start already authorised. Sign-in, CSRF/Origin checks and Agenda Access stay covered by the HTTP tests.

## What the tests cover

The first set covers the Admin area only:

- the lazy fragments of the Source page (summary, values and live steps),
- dialogs together with the htmx history,
- the LLM connection test with its `hx-indicator`,
- the model choice,
- one end-to-end flow: adding a Source.

Anything that depends only on markup stays with the HTML tests: texts and i18n, how Source Health is rendered, access rules and form validation.

## Layout and tooling

- Specs live in `apps/api/test/ui/*.spec.ts` and their fakes in `apps/api/test/ui/support/`. The `.spec` suffix keeps them out of the Vitest globs, and so out of `pnpm crap` and Stryker, while the existing `tsconfig` and ESLint still cover them.
- `apps/api/playwright.config.ts` sets `testDir: "test/ui"`. A fixture builds the fake `Application` and starts the app on a free port for each test, rather than one shared `webServer`, so each test controls its own fakes.
- A depcruise rule, `ui-tests-use-no-database`, forbids `apps/api/test/ui/**` from importing `test/support/boot.ts`, `test/support/in-process-postgres.ts` or anything else that opens a database. These files may import `src/composition-root` for its types only.
- `pnpm ui` runs the tests and is not part of `pnpm check`. In CI, a `ui` job in `ci.yml` runs in parallel with `static`, `crap` and `mutation`, and is a required check. The job:
  - installs and caches Chromium only, with no container,
  - has a 15-minute timeout,
  - runs with `retries: 0`, so a flaky test is a bug and is not retried,
  - keeps traces on failure and uploads the report only when it fails.

## Considered options

- **Vitest browser mode** was rejected. It runs tests inside its own iframe instead of loading the app's own pages, it has no equivalent of `page.route`, and it would couple the browser tests to the Vitest version Stryker depends on.
- **The real composition root with in-memory stores** was rejected. It would be more realistic, but no in-memory stores exist, and writing them would be a large amount of code outside the UI.
- **Intercepting hand-written HTML in the browser** was rejected. The real rendering would never be tested.
- **Tests against `pnpm preview` Instances or containers** were rejected. They need real infrastructure and cannot produce failures on demand.
