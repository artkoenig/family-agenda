import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // Its plugin prepares it in the background, at once here.
    await vi.waitFor(async () => {
      expect(await instance.app.sources.list()).toHaveLength(1);
    });
    const [source] = await instance.app.sources.list();
    expect(source).toMatchObject({ plain: { url: "https://calendar.example.org" }, storedSecrets: ["password"], pollIntervalSeconds: null });
    // Its row is named after its first setting and leads to its own page, where it is edited.
    const list = await page();
    expect(list).toMatch(new RegExp(`<a class="fam-row__link" href="/admin/sources/${source!.id}">[\\s\\S]*?https://calendar.example.org`));
    expect(list).toContain('<span class="fam-row__hint">every 10 minutes</span>');
    expect(list, "whether a secret is stored says nothing in a row").not.toContain("secret stored");
    const own = await get(`/admin/sources/${source!.id}`);
    expect(own).toContain('<a href="/admin/source-types/calendar">Calendar</a>');
    expect(own).toContain('value="https://calendar.example.org"');
    expect(own).not.toContain("hunter2");
    expect(own).toContain("Stored; leave empty to keep it");
    expect(own).toMatch(/<input[^>]*name="pollIntervalMinutes"[^>]*placeholder="10"/);
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
    expect(edited.headers.get("location")).toBe(`/admin/sources/${added.id}`);
    expect(await instance.app.sources.list()).toMatchObject([
      { plain: { url: "https://other.example.org" }, storedSecrets: ["password"], pollIntervalSeconds: 3600 },
    ]);

    expect(await get(`/admin/sources/${added.id}`)).toContain(`action="/admin/sources/${added.id}/remove"`);
    const removed = await instance.post(`/admin/sources/${added.id}/remove`, {}, { cookie });
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/admin/source-types/calendar");
    expect(await instance.app.sources.list()).toEqual([]);
    expect((await instance.get(`/admin/sources/${added.id}`, { cookie })).headers.get("location")).toBe("/admin/sources");
  });

  it("switches a Source Type off only while it has no Sources", async () => {
    expect(await page()).toMatch(/<button type="submit" role="switch" aria-checked="false" aria-label="Enable Calendar" class="fam-switch">/);
    await instance.app.sourceTypes.enable("calendar");
    expect(await page()).toMatch(/<button type="submit" role="switch" aria-checked="true" aria-label="Enable Calendar" class="fam-switch">/);

    await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });

    const list = await page();
    expect(list).toMatch(/<button type="submit" role="switch" aria-checked="true" aria-label="Enable Calendar" disabled="" class="fam-switch">/);
    expect(list).toContain("Locked while Calendar has Sources.");
  });

  it("hides a Source from the timeline and shows it again", async () => {
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    const own = () => get(`/admin/sources/${added.id}`);
    expect(await own()).toMatch(/<input type="hidden" name="shown" value="no"\/><button type="submit" role="switch" aria-checked="true"/);

    const hidden = await instance.post(`/admin/sources/${added.id}/shown`, { shown: "no" }, { cookie });
    expect(hidden.status).toBe(303);
    expect(hidden.headers.get("location")).toBe(`/admin/sources/${added.id}`);
    expect(await instance.app.sources.list()).toMatchObject([{ shown: false }]);
    expect(await own()).toMatch(/<input type="hidden" name="shown" value="yes"\/><button type="submit" role="switch" aria-checked="false"/);
    expect(await page()).toContain('<span class="fam-chip fam-chip--small">Hidden</span>');

    await instance.post(`/admin/sources/${added.id}/shown`, { shown: "yes" }, { cookie });
    expect(await instance.app.sources.list()).toMatchObject([{ shown: true }]);
  });

  it("renames a Source, listing it by that name and its address after it, and back once the name is emptied", async () => {
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    const own = () => get(`/admin/sources/${added.id}`);
    expect(await own()).toMatch(/<input id="[^"]*-name" name="name" maxlength="40" placeholder="https:\/\/calendar.example.org"\/>/);

    const renamed = await instance.post(`/admin/sources/${added.id}/name`, { name: "  School calendar " }, { cookie });
    expect(renamed.status).toBe(303);
    expect(renamed.headers.get("location")).toBe(`/admin/sources/${added.id}`);
    expect(await instance.app.sources.list()).toMatchObject([{ name: "School calendar" }]);
    expect(await own()).toContain('value="School calendar"');
    expect(await page()).toMatch(
      /<span class="fam-row__label">School calendar<\/span><span class="fam-row__hint">https:\/\/calendar.example.org · every 10 minutes<\/span>/,
    );

    const tooLong = await instance.post(`/admin/sources/${added.id}/name`, { name: "x".repeat(41) }, { cookie });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain("Enter a name of at most 40 characters.");
    expect(await instance.app.sources.list()).toMatchObject([{ name: "School calendar" }]);

    await instance.post(`/admin/sources/${added.id}/name`, { name: " " }, { cookie });
    expect(await instance.app.sources.list()).toMatchObject([{ name: null }]);
    expect(await page()).toMatch(/<span class="fam-row__label">https:\/\/calendar.example.org<\/span><span class="fam-row__hint">every 10 minutes<\/span>/);

    // The Source's one form saves its name with its settings; a name it refuses leaves both as they were.
    const refused = await instance.post(`/admin/sources/${added.id}`, { name: "x".repeat(41), "plain.url": "https://other.example.org" }, { cookie });
    expect(refused.status).toBe(400);
    expect(await instance.app.sources.list()).toMatchObject([{ name: null, plain: { url: "https://calendar.example.org" } }]);
    const saved = await instance.post(`/admin/sources/${added.id}`, { name: "Club", "plain.url": "https://club.example.org" }, { cookie });
    expect(saved.status).toBe(303);
    expect(await instance.app.sources.list()).toMatchObject([{ name: "Club", plain: { url: "https://club.example.org" } }]);
  });

  it("shows why a Source cannot be saved", async () => {
    await instance.app.sourceTypes.enable("calendar");

    const missing = await instance.post("/admin/sources", { sourceTypeId: "calendar", "plain.url": "" }, { cookie });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Check URL.");

    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    const edited = await instance.post(`/admin/sources/${added.id}`, { "plain.url": "", pollIntervalMinutes: "" }, { cookie });
    expect(edited.status).toBe(400);
    expect(await edited.text()).toContain("Check URL.");

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
