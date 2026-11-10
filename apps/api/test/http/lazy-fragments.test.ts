import type { SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls, type TestConfiguration } from "../support/test-source-plugin";

const password = "correct horse battery";

const configuration: TestConfiguration = {
  version: 1,
  fields: [
    { key: "messenger", label: "Messenger", secret: false, required: true },
    { key: "chats", label: "Chats", secret: false, required: false, choices: true },
    { key: "contacts", label: "Contacts", secret: false, required: false, choices: true },
  ],
};

describe("The Source Type page, which loads what its plugin offers as fragments", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let id: string;
  beforeEach(async () => {
    testPluginControls.catalogue("bridged", [{ id: "whatsapp", displayName: "WhatsApp", description: "Reads WhatsApp groups.", installed: true }]);
    testPluginControls.knowValues("bridged", [{ value: "!class:local", label: "Klasse 5b" }]);
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "bridged", displayName: "Matrix", configuration, catalogue: { configKey: "messenger" } }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("bridged");
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const added = await instance.app.sources.add({ sourceTypeId: "bridged", plain: { messenger: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    id = added.id;
    expect(await instance.app.sources.edit(added.id, { plain: { messenger: "whatsapp", chats: ["!class:local"] }, secrets: {} })).toEqual({ ok: true });
  });
  afterEach(async () => {
    testPluginControls.failAsking("bridged", null);
    testPluginControls.failChoiceField("bridged", "contacts", null);
    await instance.close();
  });

  it("renders without asking the plugin for choices, each Source row loading its values as a fragment", async () => {
    const asked = testPluginControls.choicesAsked("bridged");
    const page = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    // Its accounts are in its catalogue, which loads after it.
    const catalogue = await (await instance.get("/admin/source-types/bridged/catalogue", { cookie })).text();
    expect(testPluginControls.choicesAsked("bridged")).toBe(asked);
    expect(catalogue).toContain(
      `<span class="fam-lazy" hx-get="/admin/sources/${id}/values" hx-trigger="load" hx-swap="outerHTML" aria-busy="true" aria-live="polite" data-failed="This could not be loaded."`,
    );
    expect(catalogue).toContain("Loading Chats…");
    expect(catalogue, "a choice field with nothing chosen is told at once").toContain("Contacts: none yet");
    expect(page, "a failed request turns a pending fragment into an error").toContain("htmx:responseError");
    expect(page).toContain("htmx:sendError");
    expect(page, "an answer such as 404 for a Source removed meanwhile has words of its own").toContain(
      'data-gone="What this showed no longer exists. Reload the page."',
    );

    const values = await instance.get(`/admin/sources/${id}/values`, { cookie });
    expect(values.status).toBe(200);
    expect(await values.text()).toBe('<span class="fam-row__hint">Chats: Klasse 5b</span>');
  });

  it("explains a failed answer in the fragment and asks again only once the short failure cache expired", async () => {
    testPluginControls.failAsking("bridged", "The bridge is restarting.");
    const asked = testPluginControls.choicesAsked("bridged");
    const failed = await (await instance.get(`/admin/sources/${id}/values`, { cookie })).text();
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The plugin could not offer anything to choose from.");
    expect(failed).toContain("The bridge is restarting.");
    expect(testPluginControls.choicesAsked("bridged")).toBe(asked + 2);

    testPluginControls.failAsking("bridged", null);
    await instance.get(`/admin/sources/${id}/values`, { cookie });
    expect(testPluginControls.choicesAsked("bridged"), "the failure is kept briefly").toBe(asked + 2);

    instance.clock.advance(30_000);
    expect(await (await instance.get(`/admin/sources/${id}/values`, { cookie })).text()).toContain("Chats: Klasse 5b");
    expect(testPluginControls.choicesAsked("bridged")).toBe(asked + 4);
  });

  it("tells the values of the fields its plugin offered, and why it could not offer the others", async () => {
    expect(await instance.app.sources.edit(id as SourceId, { plain: { messenger: "whatsapp", chats: ["!class:local"], contacts: ["!class:local"] }, secrets: {} })).toEqual({ ok: true });
    testPluginControls.failChoiceField("bridged", "contacts", "The contact list is locked.");
    const values = await (await instance.get(`/admin/sources/${id}/values`, { cookie })).text();
    expect(values).toContain('<span class="fam-row__hint">Chats: Klasse 5b</span>');
    expect(values).toContain("The contact list is locked.");
    expect(values).not.toContain("Contacts: Klasse");
  });

  it("answers a fragment only to a signed-in Admin, and none for a Source that is gone", async () => {
    expect((await instance.get(`/admin/sources/${id}/values`)).headers.get("location")).toBe("/admin/sign-in");
    expect((await instance.get("/admin/sources/unknown/values", { cookie })).status).toBe(404);
  });
});
