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
    expect(page, "the risk is acknowledged with the switch").toContain('<form method="post" action="/admin/source-types/bridged/catalogue/whatsapp/enable" id="enable-whatsapp"');
    expect(page).toContain('<input type="checkbox" name="riskAcknowledged" value="yes" form="enable-whatsapp" required=""/>');

    const refused = await instance.post("/admin/source-types/bridged/catalogue/whatsapp/enable", {}, { cookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Confirm that you understand the risk.");

    const enabled = await instance.post("/admin/source-types/bridged/catalogue/whatsapp/enable", { riskAcknowledged: "yes" }, { cookie });
    expect(enabled.status).toBe(303);
    const after = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(after).toContain('action="/admin/source-types/bridged/catalogue/whatsapp/disable"');
    expect(after).not.toContain("Against WhatsApp&#39;s terms.");
  });

  it("adds an account at each enabled Messenger, starting its setup at once", async () => {
    const before = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(before).not.toContain("Add Matrix");
    expect(before).not.toContain("Add account");

    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const page = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(page).not.toContain("Add Matrix");
    expect(page).toContain('<input type="hidden" name="plain.messenger" value="whatsapp"/>');
    expect(page).toContain('aria-label="Add a WhatsApp account">Add account</button>');
    expect(page).not.toContain('value="signal"');

    const added = await instance.post("/admin/sources", { sourceTypeId: "bridged", "plain.messenger": "whatsapp" }, { cookie });
    const [source] = await instance.app.sources.list();
    expect(added.headers.get("location")).toBe(`/admin/sources/${source!.id}/setup`);
  });

  it("lists a Messenger's accounts in its sheet, and switches it off only once it has none", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const empty = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(empty).toContain("No accounts yet.");
    expect(empty).toMatch(/<button type="submit" role="switch" aria-checked="true" aria-label="Enable WhatsApp" class="fam-switch">/);

    const added = await instance.app.sources.add({ sourceTypeId: "bridged", plain: { messenger: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");

    const page = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(page).not.toContain("No accounts yet.");
    expect(page).toContain(`href="/admin/sources/${added.id}"`);
    expect(page, "its accounts are not listed again as the Source Type's Sources").not.toContain('<h2 class="fam-group__title">Sources</h2>');
    expect(page).toMatch(/<button type="submit" role="switch" aria-checked="true" aria-label="Enable WhatsApp" disabled="" class="fam-switch">/);
    expect(page).toContain("Locked while a Source uses WhatsApp.");
    // Named after its Messenger, with the chats it reads rather than what the plugin set.
    expect(page).toMatch(/<span class="fam-row__label">WhatsApp<\/span><span class="fam-row__hint">Chats: none yet<\/span>/);
    expect(page).not.toContain("account-1");

    await instance.post(`/admin/sources/${added.id}/name`, { name: "Class 3b" }, { cookie });
    const renamed = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(renamed).toMatch(/<span class="fam-row__label">Class 3b<\/span><span class="fam-row__hint">Chats: none yet<\/span>/);
  });

  it("opens the form of a Messenger's account with that Messenger given, not shown", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const form = await (await instance.get("/admin/sources/new?type=bridged&entry=whatsapp", { cookie })).text();
    expect(form).not.toMatch(/<select[^>]*name="plain.messenger"/);
    expect(form).not.toContain('for="new-bridged-messenger"');
    expect(form).toContain('<input type="hidden" name="plain.messenger" value="whatsapp"/>');
    expect(form).toContain(">Add account</button>");
    expect(form).not.toContain('id="new-bridged-interval"');
  });

  it("sets how often all accounts of a Messenger are checked", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const page = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
    expect(page).toContain('action="/admin/source-types/bridged/catalogue/whatsapp/interval"');
    expect(page).toMatch(/<label for="interval-whatsapp" class="fam-row__label">Polling interval \(optional\)<\/label>/);
    expect(page).toContain("For all WhatsApp accounts. Empty for the suggested 10.");

    const saved = await instance.post("/admin/source-types/bridged/catalogue/whatsapp/interval", { pollIntervalMinutes: "15" }, { cookie });
    expect(saved.status).toBe(303);
    expect(await (await instance.get("/admin/source-types/bridged", { cookie })).text()).toMatch(/id="interval-whatsapp"[^>]*value="15"/);

    const refused = await instance.post("/admin/source-types/bridged/catalogue/whatsapp/interval", { pollIntervalMinutes: "0" }, { cookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("The polling interval must be between");
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
    const own = await (await instance.get(`/admin/sources/${added.id}`, { cookie })).text();
    expect(own).toMatch(/<input type="checkbox" name="choice.chats" value="!class:local"\/?> Klasse 5b/);

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
  it("shows why the plugin could not offer chats or list its catalogue", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const added = await instance.app.sources.add({ sourceTypeId: "bridged", plain: { messenger: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    testPluginControls.failAsking("bridged", "The bridge is restarting.");
    try {
      const own = await (await instance.get(`/admin/sources/${added.id}`, { cookie })).text();
      expect(own).toContain("The plugin could not offer anything to choose from.");
      expect(own).toContain("The bridge is restarting.");
      expect(own).not.toContain("Nothing to choose from yet.");

      const sourceType = await (await instance.get("/admin/source-types/bridged", { cookie })).text();
      expect(sourceType).toContain("The plugin could not list them.");
      expect(sourceType).toContain("The bridge is restarting.");
    } finally {
      testPluginControls.failAsking("bridged", null);
    }
  });

  it("waits for the first read after chats were chosen, and asks again until the groups can be assigned", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    const added = await instance.app.sources.add({ sourceTypeId: "bridged", plain: { messenger: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    const nothingChosen = await (await instance.get(`/admin/sources/${added.id}`, { cookie })).text();
    expect(nothingChosen).not.toContain("Reading the Source for the first time");

    const body = new FormData();
    body.append("choice.chats", "!class:local");
    await instance.request(`/admin/sources/${added.id}`, { body, cookie });
    const waiting = await (await instance.get(`/admin/sources/${added.id}`, { cookie })).text();
    expect(waiting).toContain("Reading the Source for the first time");
    expect(waiting).toContain(`hx-get="/admin/sources/${added.id}"`);

    testPluginControls.declare("bridged", [{ externalId: "!class:local", name: "Klasse 5b" }]);
    await instance.app.polling.pollDue();
    const ready = await (await instance.get(`/admin/sources/${added.id}`, { cookie })).text();
    expect(ready).not.toContain("Reading the Source for the first time");
    expect(ready).toContain('type="checkbox" name="member.');
  });
});
