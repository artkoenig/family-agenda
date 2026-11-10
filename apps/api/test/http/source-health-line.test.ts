import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls, type TestConfiguration } from "../support/test-source-plugin";

const password = "correct horse battery";

describe("a Source's health line, kept up to date without reloading", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let sourceId: string;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "school-mail" }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("school-mail");
    const added = await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    sourceId = added.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const page = async () => (await instance.get(`/admin/sources/${sourceId}`, { cookie })).text();
  const health = async (waited = 0) => (await instance.get(`/admin/sources/${sourceId}/health?waited=${waited}`, { cookie })).text();
  const poller = (html: string) => /hx-get="(\/admin\/sources\/[^"]+\/health\?[^"]*)"[^>]*hx-trigger="load delay:([\d.]+)s"/.exec(html);

  it("polls its health line as a fragment while the Source waits for its next read, not the whole page", async () => {
    const html = await page();

    expect(html).toContain('id="source-health"');
    expect(poller(html)?.[1]).toBe(`/admin/sources/${sourceId}/health?waited=2`);
    expect(html).not.toContain(`hx-get="/admin/sources/${sourceId}" `);
    expect(html).not.toContain('hx-select="#source-attributes"');
  });

  it("answers the health line out of band and asks again, each wait longer", async () => {
    const first = await health(0);

    expect(first).toContain('id="source-health" hx-swap-oob="true"');
    expect(first).toContain("Not read successfully yet");
    const [, next, delay] = poller(first) ?? [];
    expect(next).toBe(`/admin/sources/${sourceId}/health?waited=2`);
    expect(delay).toBe("2");

    const [, , later] = poller(await health(2)) ?? [];
    expect(Number(later)).toBeGreaterThan(2);
  });

  it("stops once the Source has been read, showing when", async () => {
    testPluginControls.emit("school-mail", []);
    await instance.app.polling.pollDue();

    const html = await health(4);

    expect(html).toContain("Last read");
    expect(poller(html)).toBeNull();
    expect(poller(await page()), "a page of a read Source does not poll").toBeNull();
  });

  it("stops once the Source is failing", async () => {
    testPluginControls.failNext("school-mail", "definite");
    await instance.app.polling.pollDue();

    const html = await health(4);

    expect(html).toContain("fam-chip--problem");
    expect(poller(html)).toBeNull();
  });

  it("stops after a cap, saying quietly that it takes longer", async () => {
    const html = await health(600);

    expect(poller(html)).toBeNull();
    expect(html).toContain("This is taking longer than usual.");
    expect(html).not.toContain('role="alert"');
  });

  it("polls silently, without announcing itself as busy", async () => {
    const tag = /<span[^>]*hx-get="\/admin\/sources\/[^"]+\/health[^>]*>/.exec(await page())?.[0];

    expect(tag).toBeDefined();
    expect(tag).not.toContain("aria-busy");
    expect(tag).not.toContain("aria-live");
  });

  it("polls after a Fix of a failing Source, until the next read tells", async () => {
    testPluginControls.failNext("school-mail", "definite");
    await instance.app.polling.pollDue();
    expect(poller(await page())).toBeNull();

    expect(await instance.app.sources.edit(sourceId as never, { plain: { url: "imap2.example.org" }, secrets: {} })).toEqual({ ok: true });

    expect(poller(await page())).not.toBeNull();
  });

  it("answers nothing for a Source that is gone", async () => {
    expect((await instance.get("/admin/sources/00000000-0000-0000-0000-000000000000/health?waited=0", { cookie })).status).toBe(404);
  });
});

describe("a Source's pending Source Attributes, brought in with its health line", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let sourceId: string;
  beforeEach(async () => {
    const configuration: TestConfiguration = {
      version: 1,
      fields: [
        { key: "host", label: "Host", secret: false, required: true },
        { key: "folders", label: "Folders", secret: false, required: false, choices: true },
      ],
    };
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "mail", displayName: "Mail", configuration }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("mail");
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    const added = await instance.app.sources.add({ sourceTypeId: "mail", plain: { host: "imap.example.org", folders: ["Work"] }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    sourceId = added.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  it("asks for them with the health line, and swaps them in once the read declared them", async () => {
    const page = await (await instance.get(`/admin/sources/${sourceId}`, { cookie })).text();
    expect(page).toContain(`hx-get="/admin/sources/${sourceId}/health?attributes=pending&amp;waited=2"`);
    expect(page, "edits and an on-demand answer guard it").toContain('id="source-attributes-slot" data-edit-guard=""');
    expect(await (await instance.get(`/admin/sources/${sourceId}/health?attributes=pending&waited=2`, { cookie })).text(), "still pending: nothing to swap").not.toContain("source-attributes-slot");

    testPluginControls.declare("mail", [{ externalId: "work", name: "Work" }]);
    testPluginControls.emit("mail", []);
    await instance.app.polling.pollDue();
    const html = await (await instance.get(`/admin/sources/${sourceId}/health?attributes=pending&waited=2`, { cookie })).text();

    expect(html).toContain('id="source-attributes-slot" hx-swap-oob="true"');
    expect(html).toContain('type="checkbox" name="member.');
    expect(html, "read and declared: no more polling").not.toContain("/health?");
  });

  it("stops once a read declared none", async () => {
    testPluginControls.emit("mail", []);
    await instance.app.polling.pollDue();

    expect(await (await instance.get(`/admin/sources/${sourceId}/health?attributes=pending&waited=2`, { cookie })).text()).not.toContain("/health?");
  });

  it("leaves Source Attributes out of a health line that did not wait for them", async () => {
    const html = await (await instance.get(`/admin/sources/${sourceId}/health?waited=2`, { cookie })).text();

    expect(html).not.toContain("source-attributes-slot");
  });
});
