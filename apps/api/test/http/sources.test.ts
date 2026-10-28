import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

describe("Sources in the Admin area", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "calendar", displayName: "Calendar" }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
  });
  afterEach(async () => {
    await instance.close();
  });

  const get = async (path: string) => (await instance.get(path, { cookie })).text();
  const page = () => get("/admin/source-types/calendar");

  it("shows each Source Type as a card leading to its page, where it is enabled", async () => {
    const overview = await get("/admin/sources");
    expect(overview).toContain('href="/admin/source-types/calendar"');
    expect(overview).toContain("Not enabled");
    expect(await page()).toContain('action="/admin/source-types/calendar/enable"');
    expect(await page()).not.toContain("/admin/sources/new");

    const enabled = await instance.post("/admin/source-types/calendar/enable", {}, { cookie });

    expect(enabled.headers.get("location")).toBe("/admin/source-types/calendar");
    expect(await page()).toContain('href="/admin/sources/new?type=calendar"');
    expect(await page()).toContain("No Sources yet");
    expect(await page()).toContain('action="/admin/source-types/calendar/disable"');
    expect(await get("/admin/sources")).not.toContain("Not enabled");
  });

  it("sums up a Source Type's Sources on its card", async () => {
    await instance.app.sourceTypes.enable("calendar");
    await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });
    await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://school.example.org" }, secrets: {} });

    const overview = await get("/admin/sources");

    expect(overview).toContain("2 Sources");
    expect(overview).toContain('<span class="fam-status fam-status--ok">All OK</span>');
  });

  it("sends the old Source Types page and unknown Source Types to the Sources", async () => {
    expect((await instance.get("/admin/source-types", { cookie })).headers.get("location")).toBe("/admin/sources");
    expect((await instance.get("/admin/source-types/unknown", { cookie })).headers.get("location")).toBe("/admin/sources");
  });

  it("adds a Source from the form its plugin declares, masking the secret", async () => {
    await instance.app.sourceTypes.enable("calendar");
    // Adding opens its form in a dialog over the Source Type's page.
    const form = await get("/admin/sources/new?type=calendar");
    expect(form).toMatch(/<dialog open="" class="fam-dialog"/);
    expect(form).toContain("Add Calendar");
    expect(form).toMatch(/<input[^>]*name="secret.password"[^>]*type="password"/);
    expect(form).toMatch(/<input[^>]*name="pollIntervalMinutes"[^>]*placeholder="10"/);

    const added = await instance.post(
      "/admin/sources",
      { sourceTypeId: "calendar", "plain.url": "https://calendar.example.org", "secret.password": "hunter2", pollIntervalMinutes: "" },
      { cookie },
    );

    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/admin/source-types/calendar");
    const [source] = await instance.app.sources.list();
    expect(source).toMatchObject({ plain: { url: "https://calendar.example.org" }, storedSecrets: ["password"], pollIntervalSeconds: null });
    const list = await page();
    expect(list).toContain('value="https://calendar.example.org"');
    expect(list).not.toContain("hunter2");
    expect(list).toContain("Stored; leave empty to keep it");
  });

  it("edits a Source's configuration and polling interval, and removes it", async () => {
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({
      sourceTypeId: "calendar",
      plain: { url: "https://calendar.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!added.ok) throw new Error("adding failed");

    const edited = await instance.post(
      `/admin/sources/${added.id}`,
      { "plain.url": "https://other.example.org", "secret.password": "", pollIntervalMinutes: "60" },
      { cookie },
    );
    expect(edited.status).toBe(303);
    expect(await instance.app.sources.list()).toMatchObject([
      { plain: { url: "https://other.example.org" }, storedSecrets: ["password"], pollIntervalSeconds: 3600 },
    ]);

    const removed = await instance.post(`/admin/sources/${added.id}/remove`, {}, { cookie });
    expect(removed.status).toBe(303);
    expect(await instance.app.sources.list()).toEqual([]);
  });

  it("hides a Source from the timeline and shows it again", async () => {
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    expect(await page()).toContain("Hide from the timeline");

    const hidden = await instance.post(`/admin/sources/${added.id}/shown`, { shown: "no" }, { cookie });
    expect(hidden.status).toBe(303);
    expect(await instance.app.sources.list()).toMatchObject([{ shown: false }]);
    const list = await page();
    expect(list).toContain("hidden from the timeline");
    expect(list).toContain("Show on the timeline");

    await instance.post(`/admin/sources/${added.id}/shown`, { shown: "yes" }, { cookie });
    expect(await instance.app.sources.list()).toMatchObject([{ shown: true }]);
  });

  it("shows why a Source cannot be saved", async () => {
    await instance.app.sourceTypes.enable("calendar");

    const missing = await instance.post("/admin/sources", { sourceTypeId: "calendar", "plain.url": "" }, { cookie });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Check URL.");

    const tooOften = await instance.post(
      "/admin/sources",
      { sourceTypeId: "calendar", "plain.url": "https://calendar.example.org", pollIntervalMinutes: "0" },
      { cookie },
    );
    expect(tooOften.status).toBe(400);
    expect(await tooOften.text()).toContain("between 1 minute and 7 days");
  });

  it("keeps the Sources page to signed-in Admins", async () => {
    expect((await instance.get("/admin/sources")).headers.get("location")).toBe("/admin/sign-in");
    const post = await instance.post("/admin/sources", { sourceTypeId: "calendar" });
    expect(post.headers.get("location")).toBe("/admin/sign-in");
  });
});
