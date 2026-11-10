import type { SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";
const htmx = { "hx-request": "true" };

describe("The Add and Fix dialogs, loaded on their own into the open page", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let source: SourceId;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "calendar", displayName: "Calendar" }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: { password: "hunter2" } });
    if (!added.ok) throw new Error("adding failed");
    source = added.id;
    testPluginControls.failNext("calendar", "definite");
    instance.clock.advance(10 * 60 * 1000);
    await instance.app.polling.pollDue();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("opens from links that load the dialog alone, showing a loading dialog meanwhile", async () => {
    const typePage = await (await instance.get("/admin/source-types/calendar", { cookie })).text();
    expect(typePage).toContain('<div id="fam-dialog-slot"></div>');
    expect(typePage).toMatch(/<a [^>]*href="\/admin\/sources\/new\?type=calendar"[^>]*hx-get="\/admin\/sources\/new\?type=calendar" hx-target="#fam-dialog-slot" hx-push-url="true" data-opens-dialog="Loading…"/);
    expect(typePage, "the script that shows a loading dialog at once").toContain("[data-opens-dialog]");
    const sourcePage = await (await instance.get(`/admin/sources/${source}`, { cookie })).text();
    expect(sourcePage).toMatch(new RegExp(`hx-get="/admin/sources/${source}/fix" hx-target="#fam-dialog-slot"`));
  });

  it("answers the Add and the Fix dialog alone to htmx, the whole page to a direct link", async () => {
    for (const path of ["/admin/sources/new?type=calendar", `/admin/sources/${source}/fix`]) {
      const alone = await (await instance.get(path, { cookie, headers: htmx })).text();
      expect(alone).toMatch(/^<dialog open="" class="fam-dialog"/);
      expect(alone).not.toContain("<html");
      expect(alone).toContain('hx-target="#fam-dialog-slot"');
      const restored = await (await instance.get(path, { cookie, headers: { ...htmx, "hx-history-restore-request": "true" } })).text();
      expect(restored).toContain("<html");
      const direct = await (await instance.get(path, { cookie })).text();
      expect(direct).toContain("<html");
      expect(direct).toMatch(/<div id="fam-dialog-slot"><dialog open="" class="fam-dialog"/);
    }
  });

  it("answers a refused Add with the dialog alone, its problem and what was entered", async () => {
    const refused = await instance.post("/admin/sources", { sourceTypeId: "calendar", "plain.url": "", pollIntervalMinutes: "7" }, { cookie, headers: htmx });
    expect(refused.status).toBe(200);
    const text = await refused.text();
    expect(text).toMatch(/^<dialog open="" class="fam-dialog"/);
    expect(text).toContain('class="fam-problem"');
    expect(text).toContain('value="7"');
    const added = await instance.post("/admin/sources", { sourceTypeId: "calendar", "plain.url": "https://other.example.org", pollIntervalMinutes: "" }, { cookie, headers: htmx });
    expect(added.headers.get("hx-redirect")).toBe("/admin/source-types/calendar");
  });

  it("answers a refused Fix with the dialog alone, its problem and what was entered", async () => {
    const refused = await instance.post(`/admin/sources/${source}`, { "plain.url": "https://calendar.example.org/entered", "secret.password": "", pollIntervalMinutes: "-5" }, { cookie, headers: htmx });
    expect(refused.status).toBe(200);
    const text = await refused.text();
    expect(text).toMatch(/^<dialog open="" class="fam-dialog"/);
    expect(text).toContain('class="fam-problem"');
    expect(text).toContain('value="https://calendar.example.org/entered"');
    expect(text).toContain('value="-5"');
    const saved = await instance.post(`/admin/sources/${source}`, { "plain.url": "https://calendar.example.org/fixed", "secret.password": "", pollIntervalMinutes: "" }, { cookie, headers: htmx });
    expect(saved.headers.get("hx-redirect")).toBe(`/admin/sources/${source}`);
  });
});
