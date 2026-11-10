import { test as base, expect } from "@playwright/test";
import { serve, type Served } from "./serve";
import type { Fakes } from "./fake-application";

/** The session cookie a test's browser carries; the faked `admins.authenticate` accepts it. */
export const sessionToken = "ui-test-session";

type Fixtures = {
  /**
   * Starts the app for this test against `fakes`, with the browser signed in as an Admin; the
   * test fails afterwards if a page called anything its fakes did not give.
   */
  app: (fakes: Fakes) => Promise<Served>;
};

export const test = base.extend<Fixtures>({
  app: async ({ context }, use) => {
    const served: Served[] = [];
    await use(async (fakes) => {
      const started = await serve(fakes);
      served.push(started);
      await context.addCookies([{ name: "fb_session", value: sessionToken, url: started.url }]);
      return started;
    });
    for (const one of served) await one.close();
    for (const one of served) expect(one.unfaked, "calls the test did not fake").toEqual([]);
  },
});

export { expect };
