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

  const page = async () => (await instance.get("/admin/sources", { cookie })).text();

  it("asks to enable a Source Type before a Source can be added", async () => {
    expect(await page()).toContain('<a href="/admin/source-types">');
  });

  it("adds a Source from the form its plugin declares, masking the secret", async () => {
    await instance.app.sourceTypes.enable("calendar");
    const form = await page();
    expect(form).toContain("Add a Calendar");
    expect(form).toMatch(/<input[^>]*name="secret.password"[^>]*type="password"/);
    expect(form).toMatch(/<input[^>]*name="pollIntervalMinutes"[^>]*placeholder="10"/);

    const added = await instance.post(
      "/admin/sources",
      { sourceTypeId: "calendar", "plain.url": "https://calendar.example.org", "secret.password": "hunter2", pollIntervalMinutes: "" },
      { cookie },
    );

    expect(added.status).toBe(303);
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
