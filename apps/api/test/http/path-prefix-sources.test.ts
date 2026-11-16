import { afterEach, describe, expect, it, vi } from "vitest";
import { bootHttpForTestBelow, type HttpPrefixedTestInstance, signedInCookie } from "../support/http";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, type TestConfiguration, type TestPluginPackage } from "../support/test-source-plugin";
import type { TestOptions } from "../support/boot";

const prefix = "/agenda";

/** A Source Type whose Sources each use one Messenger and pick their chats once set up. */
const messengers: TestConfiguration = {
  version: 1,
  fields: [
    { key: "messenger", label: "Messenger", secret: false, required: true },
    { key: "chats", label: "Chats", secret: false, required: false, choices: true },
    { key: "account", label: "Account", secret: false, required: true, setByPlugin: true },
  ],
};

/** Every address from the root of the Instance that `body` emits outside the prefix. */
const outside = (body: string) =>
  body.match(/(?:href|src|action|hx-get|hx-post)="\/(?!agenda\/)[^"]*"/g) ?? [];

describe("the Admin area's Source pages below a path prefix", () => {
  let instance: HttpPrefixedTestInstance;
  let cookie: string;
  afterEach(async () => {
    await instance.close();
  });

  const boot = async (sourcePlugins: TestPluginPackage[], testOptions: TestOptions = {}) => {
    instance = await bootHttpForTestBelow(prefix, {}, { sourcePlugins, ...testOptions });
    await instance.app.recoveryKit.confirm();
    cookie = await signedInCookie(instance);
  };
  /** A page or fragment, checked to emit no address outside the prefix. */
  const page = async (path: string, headers: Record<string, string> = {}) => {
    const body = await (await instance.get(`${prefix}${path}`, { cookie, headers })).text();
    expect(outside(body), path).toEqual([]);
    return body;
  };
  const got = async (path: string, headers: Record<string, string> = {}) => instance.get(`${prefix}${path}`, { cookie, headers });
  const posted = async (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    instance.post(`${prefix}${path}`, form, { cookie, headers });
  const htmx = { "hx-request": "true" };

  it("enables a Source Type, adds, changes, hides and removes a Source, all below the prefix", async () => {
    await boot([{ sourceTypeId: "calendar", displayName: "Calendar" }]);

    expect(await page("/admin/sources")).toContain(`href="${prefix}/admin/source-types/calendar"`);
    expect((await got("/admin/source-types")).headers.get("location")).toBe(`${prefix}/admin/sources`);
    expect((await got("/admin/source-types/unknown")).headers.get("location")).toBe(`${prefix}/admin/sources`);
    expect(await page("/admin/source-types/calendar")).toContain(`action="${prefix}/admin/source-types/calendar/enable"`);
    expect((await posted("/admin/source-types/calendar/enable", {})).headers.get("location")).toBe(
      `${prefix}/admin/source-types/calendar`,
    );
    const typePage = await page("/admin/source-types/calendar");
    expect(typePage).toContain(`href="${prefix}/admin/sources/new?type=calendar"`);
    expect(typePage).toContain(`href="${prefix}/admin/sources"`);

    expect((await got("/admin/sources/new")).headers.get("location")).toBe(`${prefix}/admin/sources`);
    expect((await got("/admin/sources/new?type=unknown")).headers.get("location")).toBe(`${prefix}/admin/source-types/unknown`);
    const form = await page("/admin/sources/new?type=calendar");
    expect(form).toContain(`hx-post="${prefix}/admin/sources"`);
    expect(await page("/admin/sources/new?type=calendar", htmx)).toContain(`action="${prefix}/admin/sources"`);
    const added = await posted("/admin/sources", { sourceTypeId: "calendar", "plain.url": "https://calendar.example.org" }, htmx);
    expect(added.headers.get("HX-Redirect")).toBe(`${prefix}/admin/source-types/calendar`);
    await vi.waitFor(async () => {
      expect(await instance.app.sources.list()).toHaveLength(1);
    });
    const [source] = await instance.app.sources.list();
    const id = source!.id;
    expect(await page("/admin/source-types/calendar")).toContain(`href="${prefix}/admin/sources/${id}"`);

    const own = await page(`/admin/sources/${id}`);
    expect(own).toContain(`action="${prefix}/admin/sources/${id}/remove"`);
    expect(own).toContain(`href="${prefix}/admin/source-types/calendar"`);
    expect(await page(`/admin/sources/${id}/fix`)).toContain(`hx-post="${prefix}/admin/sources/${id}"`);
    expect(await page(`/admin/sources/${id}/fix`, htmx)).toContain(`href="${prefix}/admin/sources/${id}"`);
    await page(`/admin/sources/${id}/health`);
    await page(`/admin/sources/${id}/values`);
    await page(`/admin/sources/${id}/attributes`);

    expect((await posted(`/admin/sources/${id}`, { "plain.url": "https://other.example.org" })).headers.get("location")).toBe(
      `${prefix}/admin/sources/${id}`,
    );
    expect((await posted(`/admin/sources/${id}`, { "plain.url": "https://third.example.org" }, htmx)).headers.get("HX-Redirect")).toBe(
      `${prefix}/admin/sources/${id}`,
    );
    expect((await posted(`/admin/sources/${id}/name`, { name: "School" })).headers.get("location")).toBe(`${prefix}/admin/sources/${id}`);
    expect((await posted(`/admin/sources/${id}/shown`, { shown: "no" })).headers.get("location")).toBe(`${prefix}/admin/sources/${id}`);
    expect((await posted(`/admin/sources/${id}/attributes`, {})).headers.get("location")).toBe(`${prefix}/admin/sources/${id}`);
    // A page answered instead of a dialog loads whole, at its address below the prefix.
    const whole = await got("/admin/source-types/calendar", { ...htmx, "hx-target": "fam-dialog-slot" });
    expect(whole.headers.get("HX-Redirect")).toBe(`${prefix}/admin/source-types/calendar`);

    expect((await posted(`/admin/sources/${id}/remove`, {})).headers.get("location")).toBe(`${prefix}/admin/source-types/calendar`);
    expect((await got(`/admin/sources/${id}`)).headers.get("location")).toBe(`${prefix}/admin/sources`);
    expect((await got(`/admin/sources/${id}/fix`)).headers.get("location")).toBe(`${prefix}/admin/sources`);
    expect((await got(`/admin/sources/${id}/setup`)).headers.get("location")).toBe(`${prefix}/admin/sources`);
    for (const path of ["", "/name", "/shown", "/attributes", "/remove"])
      expect((await posted(`/admin/sources/${id}${path}`, {})).headers.get("location"), path).toBe(`${prefix}/admin/sources`);
    expect((await got("/admin/sources/adding/00000000-0000-0000-0000-000000000000")).headers.get("location")).toBe(
      `${prefix}/admin/sources`,
    );
    expect((await got("/admin/sources/adding/00000000-0000-0000-0000-000000000000/row")).headers.get("HX-Redirect")).toBe(
      `${prefix}/admin/sources`,
    );
  });

  it("enables a catalogue entry, adds an account and follows its setup steps, all below the prefix", async () => {
    testPluginControls.catalogue("bridged", [
      { id: "whatsapp", displayName: "WhatsApp", description: "Reads WhatsApp groups.", installed: true },
    ]);
    testPluginControls.setupShows("bridged", { status: "waiting", qrCode: "2@scan-me" });
    await boot([
      { sourceTypeId: "bridged", displayName: "Matrix", configuration: messengers, catalogue: { configKey: "messenger" }, liveSteps: ["login"] },
    ]);
    await instance.app.sourceTypes.enable("bridged");

    expect(await page("/admin/source-types/bridged")).toContain(`hx-get="${prefix}/admin/source-types/bridged/catalogue"`);
    expect(await page("/admin/source-types/bridged/catalogue")).toContain(
      `action="${prefix}/admin/source-types/bridged/catalogue/whatsapp/enable"`,
    );
    expect((await posted("/admin/source-types/bridged/catalogue/whatsapp/enable", { riskAcknowledged: "yes" })).headers.get("location")).toBe(
      `${prefix}/admin/source-types/bridged`,
    );
    const catalogue = await page("/admin/source-types/bridged/catalogue");
    expect(catalogue).toContain(`action="${prefix}/admin/source-types/bridged/catalogue/whatsapp/interval"`);
    expect(catalogue).toContain(`action="${prefix}/admin/sources"`);
    expect((await posted("/admin/source-types/bridged/catalogue/whatsapp/interval", { pollIntervalMinutes: "15" })).headers.get("location")).toBe(
      `${prefix}/admin/source-types/bridged`,
    );
    await page("/admin/sources/new?type=bridged");
    await page("/admin/sources/new?type=bridged&entry=whatsapp");

    const release = testPluginControls.holdAdding("bridged");
    const started = await posted("/admin/sources", { sourceTypeId: "bridged", "plain.messenger": "whatsapp" });
    expect(started.headers.get("location")).toBe(`${prefix}/admin/source-types/bridged`);
    const adding = new RegExp(`hx-get="(${prefix}/admin/sources/adding/[0-9a-f-]+)/row"`).exec(await page("/admin/source-types/bridged"))?.[1];
    if (!adding) throw new Error("no row of a Source being added");
    const unprefixed = adding.slice(prefix.length);
    expect((await got(unprefixed)).headers.get("location")).toBe(`${prefix}/admin/source-types/bridged`);
    await page(`${unprefixed}/row`);
    release();
    await vi.waitFor(async () => {
      expect((await got(`${unprefixed}/row`)).headers.get("HX-Redirect")).toBe(adding);
    });
    const [source] = await instance.app.sources.list();
    const id = source!.id;
    expect((await got(unprefixed)).headers.get("location")).toBe(`${prefix}/admin/sources/${id}/setup`);

    const setup = await page(`/admin/sources/${id}/setup`);
    expect(setup).toContain(`hx-get="${prefix}/admin/sources/${id}/setup/login" hx-trigger="load"`);
    expect(setup).toContain(`href="${prefix}/admin/source-types/bridged"`);
    expect(await page(`/admin/sources/${id}/setup/login`)).toContain(
      `hx-get="${prefix}/admin/sources/${id}/setup/login" hx-trigger="load delay:3s"`,
    );
    expect(await page(`/admin/sources/${id}/fix`)).toContain(`hx-get="${prefix}/admin/sources/${id}/setup/login"`);
    const own = await page(`/admin/sources/${id}`);
    expect(own).toContain(`${prefix}/admin/sources/${id}/choices/chats`);
    await page(`/admin/sources/${id}/choices/chats`);
    await page("/admin/source-types/bridged/catalogue");

    expect((await posted(`/admin/sources/${id}/remove`, {})).headers.get("location")).toBe(`${prefix}/admin/source-types/bridged`);
  });

  it("opens a message and its attachment, and deletes an Item, all below the prefix", async () => {
    const extractor = new ScriptedExtractor();
    await boot([{ sourceTypeId: "school-mail", needsLlm: true }], { extractor, blobStore: new InMemoryBlobStore() });
    await instance.app.sourceTypes.enable("school-mail");
    await instance.app.sources.add({ sourceTypeId: "school-mail", plain: { url: "imap.example.org" }, secrets: {} });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    extractor.script("Elternabend", [extracted({ title: "Elternabend", date: { daysAfter: 1 }, evidence: "Morgen ist Elternabend" })]);
    testPluginControls.emit("school-mail", [
      {
        externalId: "m1",
        occurredAt: new Date("2026-09-14T06:00:00Z"),
        attributes: ["main"],
        content: {
          kind: "raw-message",
          text: "Subject: Elternabend\n\nMorgen ist Elternabend.",
          attachments: [{ filename: "Einladung.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }],
        },
      },
    ]);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    const agenda = await (await instance.get(`${prefix}/agendas/${created.id}`)).text();
    const messageId = /\/admin\/messages\/([0-9a-f-]+)"/.exec(agenda)?.[1];
    if (!messageId) throw new Error("no message");

    const message = await page(`/admin/messages/${messageId}`);
    expect(message).toContain(`href="${prefix}/admin/messages/${messageId}/attachments/0"`);
    const pdf = await got(`/admin/messages/${messageId}/attachments/0`);
    expect(pdf.status).toBe(200);
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const itemId = new RegExp(`action="${prefix}/admin/items/([0-9a-f-]+)/delete"`).exec(message)?.[1];
    if (!itemId) throw new Error("no Item to delete");
    expect((await posted(`/admin/items/${itemId}/delete`, { message: messageId })).headers.get("location")).toBe(
      `${prefix}/admin/messages/${messageId}`,
    );
    expect((await posted(`/admin/items/${itemId}/delete`, { message: "nonsense" })).headers.get("location")).toBe(`${prefix}/admin`);
  });
});
