import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls, type TestConfiguration } from "../support/test-source-plugin";

const password = "correct horse battery";

const configuration: TestConfiguration = {
  version: 1,
  fields: [{ key: "messenger", label: "Messenger", secret: false, required: true }],
};

describe("The catalogue of a Source Type, loaded as a fragment of its page", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    testPluginControls.catalogue("bridged", [{ id: "whatsapp", displayName: "WhatsApp", description: "Reads WhatsApp groups.", installed: true }]);
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "bridged", displayName: "Matrix", configuration, catalogue: { configKey: "messenger" } }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("bridged");
    // Past what was asked while the Instance started and the Source Type was enabled.
    instance.clock.advance(60_000);
  });
  afterEach(async () => {
    testPluginControls.failAsking("bridged", null);
    await instance.close();
  });

  it("renders the page without asking the plugin for its entries, the catalogue area showing a placeholder", async () => {
    const asked = testPluginControls.catalogueAsked("bridged");
    const page = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(testPluginControls.catalogueAsked("bridged")).toBe(asked);
    expect(page).toContain('hx-get="/admin/source-types/bridged/catalogue" hx-trigger="load" hx-swap="outerHTML" aria-busy="true"');
    expect(page).toContain("Loading Networks…");
    expect(page).not.toContain("Reads WhatsApp groups.");
  });

  it("answers the catalogue's entries, asking the plugin once for them", async () => {
    const asked = testPluginControls.catalogueAsked("bridged");
    const fragment = await instance.get("/admin/source-types/bridged/catalogue", { cookie });
    expect(fragment.status).toBe(200);
    const text = await fragment.text();
    expect(text).toContain('<h2 id="catalogue-title" class="fam-group__title">Networks</h2>');
    expect(text).toContain("Reads WhatsApp groups.");
    expect(text).not.toContain("<html");
    expect(testPluginControls.catalogueAsked("bridged")).toBe(asked + 1);

    await instance.get("/admin/source-types/bridged/catalogue", { cookie });
    expect(testPluginControls.catalogueAsked("bridged"), "kept briefly").toBe(asked + 1);
  });

  it("explains why the plugin could not list its catalogue, within that area", async () => {
    testPluginControls.failAsking("bridged", "The bridge is restarting.");
    const fragment = await (await instance.get("/admin/source-types/bridged/catalogue", { cookie })).text();
    expect(fragment).toContain("The plugin could not list them.");
    expect(fragment).toContain("The bridge is restarting.");
  });

  it("answers no catalogue for a Source Type without one", async () => {
    expect((await instance.get("/admin/source-types/unknown/catalogue", { cookie })).status).toBe(404);
  });
});
