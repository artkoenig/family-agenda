import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls, type TestConfiguration } from "../support/test-source-plugin";

const password = "correct horse battery";

const configuration: TestConfiguration = {
  version: 1,
  fields: [
    { key: "host", label: "Host", secret: false, required: true },
    { key: "folders", label: "Folders", secret: false, required: false, choices: true },
    { key: "labels", label: "Labels", secret: false, required: false, choices: true },
  ],
};

describe("A Source's page, whose choice fields load as fragments", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let id: string;
  beforeEach(async () => {
    testPluginControls.knowValues("mail", [{ value: "INBOX", label: "Inbox" }, { value: "Work", label: "Work" }]);
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "mail", displayName: "Mail", configuration }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("mail");
    const added = await instance.app.sources.add({ sourceTypeId: "mail", plain: { host: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    id = added.id;
    expect(await instance.app.sources.edit(added.id, { plain: { host: "imap.example.org", folders: ["Work"] }, secrets: {} })).toEqual({ ok: true });
    instance.clock.advance(60 * 60_000);
  });
  afterEach(async () => {
    testPluginControls.failChoiceField("mail", "labels", null);
    await instance.close();
  });

  it("renders without asking the plugin for choices, each field disabled and loading on its own, its selection kept", async () => {
    const asked = testPluginControls.choicesAsked("mail");
    const page = await (await instance.get(`/admin/sources/${id}`, { cookie })).text();
    expect(testPluginControls.choicesAsked("mail")).toBe(asked);
    for (const key of ["folders", "labels"]) {
      expect(page).toContain(`<div class="fam-lazy" hx-get="/admin/sources/${id}/choices/${key}?id=${id}-${key}"`);
    }
    expect(page).toMatch(/<fieldset class="fam-field" disabled="" aria-busy="true"><legend>Folders/);
    expect(page, "saved meanwhile, the stored selection stays").toContain('<input type="hidden" name="choice.folders" value="Work"/>');
  });

  it("answers one field with its values, the stored ones ticked, asking the plugin for that field only", async () => {
    const asked = testPluginControls.choicesAsked("mail");
    const field = await (await instance.get(`/admin/sources/${id}/choices/folders?id=${id}-folders`, { cookie })).text();
    expect(testPluginControls.choicesAsked("mail")).toBe(asked + 1);
    expect(field).toMatch(/^<fieldset class="fam-field" id=".*-folders">/);
    expect(field).toMatch(/value="Work" checked=""\/> Work/);
    expect(field).toContain('value="INBOX"/> Inbox');
  });

  it("explains a field the plugin cannot offer, keeping its stored selection on saving", async () => {
    expect(await instance.app.sources.edit(id as never, { plain: { host: "imap.example.org", folders: ["Work"], labels: ["urgent"] }, secrets: {} })).toEqual({ ok: true });
    testPluginControls.failChoiceField("mail", "labels", "The label list is locked.");
    const field = await (await instance.get(`/admin/sources/${id}/choices/labels?id=x`, { cookie })).text();
    expect(field).toContain("The label list is locked.");
    expect(field, "its stored selection, still ticked").toMatch(/name="choice.labels" value="urgent" checked=""/);
    const saved = await instance.post(`/admin/sources/${id}`, { "plain.host": "imap.example.org", "choice.folders": "Work", "choice.labels": "urgent", pollIntervalMinutes: "" }, { cookie });
    expect(saved.status).toBe(303);
    expect((await instance.app.sources.list()).find((source) => source.id === id)?.plain.labels).toEqual(["urgent"]);
  });

  it("answers no field for a Source or a field that does not exist", async () => {
    expect((await instance.get("/admin/sources/unknown/choices/folders", { cookie })).status).toBe(404);
    expect((await instance.get(`/admin/sources/${id}/choices/host`, { cookie })).status).toBe(404);
  });
});
