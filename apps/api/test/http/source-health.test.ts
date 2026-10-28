import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";
const minutes = 60 * 1000;

describe("Source health in the Admin area and on Views", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let source: SourceId;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, {
      sourcePlugins: [
        {
          sourceTypeId: "calendar",
          displayName: "Calendar",
          setupSteps: [{ id: "share", title: "Share the calendar", description: "Share it with the address below." }],
        },
      ],
    });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({
      sourceTypeId: "calendar",
      plain: { url: "https://calendar.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!added.ok) throw new Error("adding failed");
    source = added.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const tick = async () => {
    instance.clock.advance(10 * minutes);
    await instance.app.polling.pollDue();
  };
  const sourcesPage = async () => (await instance.get("/admin/sources", { cookie })).text();
  const failingBanner = /<div class="fam-banner fam-banner--problem" role="status">[\s\S]*?A Source is failing/;

  it("shows a Source's status and the time of its last successful run", async () => {
    await tick();

    const page = await sourcesPage();
    expect(page).toContain('<span class="fam-status fam-status--ok">OK</span>');
    expect(page).toContain("Last read Mon 14 Sept, 09:10");
    expect(page).not.toMatch(failingBanner);
  });

  it("shows a Failing Source with its last error, and a banner in the whole Admin area", async () => {
    await tick();
    testPluginControls.failNext("calendar", "definite");
    await tick();

    const page = await sourcesPage();
    expect(page).toContain('<span class="fam-status fam-status--problem">Failing</span>');
    expect(page).toContain("Last error: calendar failed");
    expect(page).toContain("Last read Mon 14 Sept, 09:10");
    expect(page).toMatch(failingBanner);
    expect(await (await instance.get("/admin/views", { cookie })).text()).toMatch(failingBanner);
  });

  it("shows the last error of an OK Source whose last run failed", async () => {
    testPluginControls.failNext("calendar", "temporary");
    await tick();

    const page = await sourcesPage();
    expect(page).toContain('<span class="fam-status fam-status--ok">OK</span>');
    expect(page).toContain("Last error: calendar failed");
    expect(page).toContain("Not read successfully yet");
    expect(page).not.toMatch(failingBanner);
  });

  it("offers a Fix button on a Failing Source, which opens the form adding it uses and runs it again on saving", async () => {
    expect(await sourcesPage()).not.toContain(`href="/admin/sources/${source}/fix"`);
    testPluginControls.failNext("calendar", "definite");
    await tick();
    expect(await sourcesPage()).toContain(`href="/admin/sources/${source}/fix"`);

    const fix = await (await instance.get(`/admin/sources/${source}/fix`, { cookie })).text();
    expect(fix).toMatch(/<dialog open="" class="fam-dialog"/);
    expect(fix).toContain(`action="/admin/sources/${source}"`);
    expect(fix).toContain('value="https://calendar.example.org"');
    expect(fix).toMatch(/<input[^>]*name="secret.password"[^>]*placeholder="Stored; leave empty to keep it"/);
    expect(fix).toContain("Last error: calendar failed");
    const step = "<strong>Share the calendar</strong> <span>Share it with the address below.</span>";
    expect(fix).toContain(step);
    expect(await (await instance.get("/admin/sources/new", { cookie })).text(), "adding shows the same steps").toContain(step);

    const saved = await instance.post(
      `/admin/sources/${source}`,
      { "plain.url": "https://calendar.example.org/fixed", "secret.password": "", pollIntervalMinutes: "" },
      { cookie },
    );
    expect(saved.status).toBe(303);
    const runs = testPluginControls.runs("calendar").length;
    await instance.app.polling.pollDue();
    expect(testPluginControls.runs("calendar")).toHaveLength(runs + 1);
    expect(await sourcesPage()).not.toMatch(failingBanner);
  });

  it("shows a Source whose plugin is no longer installed as Failing", async () => {
    await rm(join(instance.workspacePackages, "calendar"), { recursive: true });
    await instance.restart();

    const page = await sourcesPage();
    expect(page).toContain('<span class="fam-status fam-status--problem">Failing</span>');
    expect(page).toContain("Source Type not installed");
  });

  it("shows one generic out-of-date line on every View while a Source is Failing", async () => {
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error("creating failed");
    const view = async () => (await instance.get(`/views/${created.id}`)).text();
    const line = '<p class="fam-out-of-date" role="status">Some of this may be out of date.</p>';
    expect(await view()).not.toContain(line);

    testPluginControls.failNext("calendar", "definite");
    await tick();

    const page = await view();
    expect(page).toContain(line);
    expect(page).not.toContain("calendar failed");
    expect(page).not.toContain("Calendar");
  });
});
