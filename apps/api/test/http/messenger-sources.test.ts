import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

/** A Source Type whose Sources each use one Messenger and pick their chats once set up. */
const configuration = `{
  version: 1,
  fields: [
    { key: "messenger", label: "Messenger", secret: false, required: true },
    { key: "chats", label: "Chats", secret: false, required: false, choices: () => Promise.resolve([]) },
    { key: "account", label: "Account", secret: false, required: true, setByPlugin: true },
  ],
}`;

describe("Sources of a Source Type with a catalogue and a live setup step", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    testPluginControls.catalogue("bridged", [
      { id: "whatsapp", displayName: "WhatsApp", description: "Reads WhatsApp groups.", installed: true, riskNotice: "Against WhatsApp's terms." },
      { id: "signal", displayName: "Signal", description: "Reads Signal groups.", installed: false },
    ]);
    testPluginControls.setupShows("bridged", { status: "waiting", qrCode: "2@scan-me" });
    instance = await bootHttpForTest(
      {},
      { sourcePlugins: [{ sourceTypeId: "bridged", displayName: "Matrix", configuration, catalogue: { configKey: "messenger" }, liveSteps: ["login"] }] },
    );
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("bridged");
  });
  afterEach(async () => {
    await instance.close();
  });

  it("lists the catalogue under its Source Type and enables an entry once its risk is acknowledged", async () => {
    const page = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(page).toContain("Reads WhatsApp groups.");
    expect(page).toContain("Against WhatsApp&#39;s terms.");
    expect(page).toContain("Not installed on this Instance");
    expect(page).not.toContain("/catalogue/signal/enable");

    const refused = await instance.post("/admin/source-types/bridged/catalogue/whatsapp/enable", {}, { cookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Confirm that you understand the risk.");

    const enabled = await instance.post("/admin/source-types/bridged/catalogue/whatsapp/enable", { riskAcknowledged: "yes" }, { cookie });
    expect(enabled.status).toBe(303);
    expect(await (await instance.get("/admin/source-types/bridged", { cookie })).text()).toContain("Disable WhatsApp");
  });

  it("asks to enable a Messenger before a Source can be added", async () => {
    const form = await (await instance.get("/admin/sources/new?type=bridged", { cookie })).text();
    expect(form).toContain("None is enabled yet.");
    expect(form).toContain('<a href="/admin/source-types/bridged">Enable one</a>');
  });

  it("adds a Source with a chosen Messenger, then shows the QR code to scan until it is done", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const form = await (await instance.get("/admin/sources/new?type=bridged", { cookie })).text();
    expect(form).toMatch(/<select[^>]*name="plain.messenger"/);
    expect(form).toContain('<option value="whatsapp"');
    expect(form).not.toContain("plain.account");
    expect(form).toContain("Offered once the Source is set up.");

    const added = await instance.post("/admin/sources", { sourceTypeId: "bridged", "plain.messenger": "whatsapp" }, { cookie });
    expect(added.status).toBe(303);
    const [source] = await instance.app.sources.list();
    expect(added.headers.get("location")).toBe(`/admin/sources/${source!.id}/setup`);

    const setup = await (await instance.get(`/admin/sources/${source!.id}/setup`, { cookie })).text();
    expect(setup).toContain('aria-label="QR code to scan"');
    expect(setup).toMatch(/<svg[^>]*viewBox/);
    expect(setup).toContain(`hx-get="/admin/sources/${source!.id}/setup/login"`);

    testPluginControls.setupShows("bridged", { status: "done" });
    const fragment = await (await instance.get(`/admin/sources/${source!.id}/setup/login`, { cookie })).text();
    expect(fragment).toContain("Done.");
    expect(fragment).not.toContain("hx-get");
  });

  it("shows why a Source could not be set up", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    testPluginControls.failAdding("bridged");

    const refused = await instance.post("/admin/sources", { sourceTypeId: "bridged", "plain.messenger": "whatsapp" }, { cookie });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("The Source could not be set up: the homeserver is unreachable");
  });

  it("allow-lists chats with one checkbox each, and clears them all", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const added = await instance.app.sources.add({ sourceTypeId: "bridged", plain: { messenger: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    testPluginControls.knowValues("bridged", [
      { value: "!class:local", label: "Klasse 5b" },
      { value: "!club:local", label: "Fußballverein" },
    ]);
    const list = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(list).toMatch(/<input type="checkbox" name="choice.chats" value="!class:local"\/?> Klasse 5b/);

    const body = new FormData();
    body.append("choice.chats", "");
    body.append("choice.chats", "!class:local");
    body.append("choice.chats", "!club:local");
    expect((await instance.request(`/admin/sources/${added.id}`, { body, cookie })).status).toBe(303);
    expect((await instance.app.sources.list())[0]?.plain.chats).toEqual(["!class:local", "!club:local"]);

    const cleared = new FormData();
    cleared.append("choice.chats", "");
    await instance.request(`/admin/sources/${added.id}`, { body: cleared, cookie });
    const [source] = await instance.app.sources.list();
    expect(source?.plain).toMatchObject({ messenger: "whatsapp", chats: [] });
  });
});
