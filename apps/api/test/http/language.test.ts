import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeTessdataCatalog } from "../support/fake-tessdata-catalog";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

/** The settings list's entry for a section, from its link to the link's end. */
const entryOf = (page: string, label: string) =>
  new RegExp(`<a class="fam-navitem"[^>]*>(?:(?!</a>).)*${label}(?:(?!</a>).)*</a>`, "s").exec(page)?.[0] ?? "";

/** The forms of a page with their hidden and chosen values, as `action: name=value …`. */
const formsOf = (page: string) =>
  [...page.matchAll(/<form method="post" action="([^"]+)"[^>]*>(.*?)<\/form>/gs)].map(
    ([, action, body]) =>
      `${action}: ${[...body!.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)"/g)].map(([, name, value]) => `${name}=${value}`).join(" ")}`.trim(),
  );

describe("the language settings over HTTP", () => {
  let instance: HttpTestInstance;
  let catalog: FakeTessdataCatalog;
  let cookie: string;
  beforeEach(async () => {
    catalog = new FakeTessdataCatalog();
    instance = await bootHttpForTest({}, { tessdataCatalog: catalog });
    await instance.post("/setup", { email: "anna@example.org", password, language: "de" });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
  });
  afterEach(async () => {
    await instance.close();
  });

  const get = async (path: string) => (await instance.get(path, { cookie })).text();
  const post = (path: string, form: Record<string, string>) => instance.post(path, form, { cookie });

  it("lists the Family Language and the OCR languages among the settings", async () => {
    const page = await get("/admin/language");

    expect(entryOf(page, "Sprache")).toContain("Deutsch; OCR auf Deutsch");
    expect(entryOf(page, "Sprache")).toContain('aria-current="page"');
    expect(page).toContain('<option value="de" selected="">Deutsch</option>');
  });

  it("changes the Family Language", async () => {
    const saved = await post("/admin/language", { language: "en" });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/admin/language");

    expect(entryOf(await get("/admin/language"), "Language")).toContain("English; OCR in German");
    expect((await post("/admin/language", { language: "fr" })).status).toBe(400);
  });

  it("adds, orders and drops OCR languages among the installed models", async () => {
    expect(formsOf(await get("/admin/language"))).toContain("/admin/language/ocr:");

    await post("/admin/language/ocr", { ocrLanguages: "deu+eng" });
    const page = await get("/admin/language");
    expect(entryOf(page, "Sprache")).toContain("Deutsch; OCR auf Deutsch und Englisch");
    const forms = formsOf(page);
    // English moves up before German, and either can be dropped while the other stays.
    expect(forms).toContain("/admin/language/ocr: ocrLanguages=eng+deu");
    expect(forms).toContain("/admin/language/ocr: ocrLanguages=eng");
    expect(forms).toContain("/admin/language/ocr: ocrLanguages=deu");

    const refused = await post("/admin/language/ocr", { ocrLanguages: "deu+fra" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Lade zuerst sein Modell herunter.");
  });

  it("downloads a model, offers it for OCR, and removes it once unselected", async () => {
    const offered = await get("/admin/language");
    expect(offered).toContain('<option value="fra">Französisch</option>');

    const installed = await post("/admin/language/models", { language: "fra" });
    expect(installed.status).toBe(303);
    let page = await get("/admin/language");
    expect(formsOf(page)).toContain("/admin/language/models/fra/remove:");
    expect(page).not.toContain('<option value="fra">Französisch</option>');

    await post("/admin/language/ocr", { ocrLanguages: "deu+fra" });
    page = await get("/admin/language");
    expect(formsOf(page)).not.toContain("/admin/language/models/fra/remove:");
    expect(formsOf(page)).not.toContain("/admin/language/models/deu/remove:");

    await post("/admin/language/ocr", { ocrLanguages: "deu" });
    expect((await post("/admin/language/models/fra/remove", {})).status).toBe(303);
    expect(await get("/admin/language")).toContain('<option value="fra">Französisch</option>');
  });

  it("shows why a download failed", async () => {
    catalog.fail("ita", "tampered");

    const failed = await post("/admin/language/models", { language: "ita" });

    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain("does not match its checksum");
  });

  it("marks a chosen OCR language whose model is missing, and offers to download it", async () => {
    await post("/admin/language/models", { language: "fra" });
    await post("/admin/language/ocr", { ocrLanguages: "deu+fra" });
    await rm(join(instance.tessdataDirectory, "fra.traineddata"));

    const page = await get("/admin/language");

    expect(entryOf(page, "Sprache")).toContain("fam-navitem__summary--attention");
    expect(page).toContain("Nicht installiert");
    expect(formsOf(page)).toContain("/admin/language/models: language=fra");
  });
});

describe("dates in the Family Language", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest();
    await instance.post("/setup", { email: "anna@example.org", password, language: "de" });
  });
  afterEach(async () => {
    await instance.close();
  });

  it("are formatted in its locale on an Agenda", async () => {
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");

    const page = await (await instance.get(`/agendas/${created.id}`)).text();

    expect(page).toContain("Mo., 14. Sept.");
    expect(page).toContain("Mittwoch");

    await instance.app.languages.setLanguage("en");
    expect(await (await instance.get(`/agendas/${created.id}`)).text()).toContain("Mon 14 Sept");
  });
});
