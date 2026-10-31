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

describe("the display and OCR settings over HTTP", () => {
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

  it("lists the Family Language among the settings, with the Theme switch of the browser", async () => {
    const page = await get("/admin/display");

    expect(entryOf(page, "Anzeige")).toContain("Deutsch");
    expect(entryOf(page, "Anzeige")).toContain('aria-current="page"');
    expect(page).toContain('<option value="de" selected="">Deutsch</option>');
    // The Theme lives in the browser: the select has no form and no name to post.
    expect(page).toMatch(/<select id="theme" data-theme-select="true">\s*<option value="system">Wie das Gerät<\/option><option value="light">Hell<\/option><option value="dark">Dunkel<\/option>/);
    expect(page).toContain('localStorage.setItem("fam-theme", mode)');
  });

  it("changes the Family Language", async () => {
    const saved = await post("/admin/display", { language: "en" });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/admin/display");

    expect(entryOf(await get("/admin/display"), "Display")).toContain("English");
    expect((await post("/admin/display", { language: "fr" })).status).toBe(400);
  });

  it("adds, orders and drops OCR languages, each with its model", async () => {
    const before = await get("/admin/llm");
    expect(before).toContain('<option value="eng">Englisch</option>');
    expect(before).toContain('<option value="fra">Französisch</option>');
    expect(formsOf(before)).not.toContain("/admin/llm/ocr/deu/remove:");

    expect((await post("/admin/llm/ocr", { language: "eng" })).status).toBe(303);
    expect((await post("/admin/llm/ocr", { language: "fra" })).status).toBe(303);
    let page = await get("/admin/llm");
    expect(entryOf(page, "KI")).toContain("Nicht eingerichtet; OCR auf Deutsch, Englisch und Französisch");
    expect(page).not.toContain('<option value="fra">Französisch</option>');
    expect(formsOf(page)).toContain("/admin/llm/ocr/fra/remove:");
    expect(formsOf(page)).toContain("/admin/llm/ocr/deu/remove:");
    expect(formsOf(page)).not.toContain("/admin/llm/ocr/deu/up:");

    await post("/admin/llm/ocr/fra/up", {});
    expect(entryOf(await get("/admin/llm"), "KI")).toContain("OCR auf Deutsch, Französisch und Englisch");

    expect((await post("/admin/llm/ocr/fra/remove", {})).status).toBe(303);
    page = await get("/admin/llm");
    expect(page).toContain('<option value="fra">Französisch</option>');
    expect((await post("/admin/llm/ocr/xyz/remove", {})).status).toBe(400);
  });

  it("switches OCR on and off, whatever the model of the LLM endpoint", async () => {
    let page = await get("/admin/llm");
    expect(page).toMatch(/role="switch" aria-checked="true" aria-labelledby="ocr-enabled"/);
    expect(formsOf(page)).toContain("/admin/llm/ocr/enabled: ocr=no");
    expect(page).not.toContain("Das Modell liest Bilder");
    expect(entryOf(page, "KI")).toContain("OCR auf Deutsch");

    expect((await post("/admin/llm/ocr/enabled", { ocr: "no" })).status).toBe(303);
    page = await get("/admin/llm");
    expect(page).toMatch(/role="switch" aria-checked="false" aria-labelledby="ocr-enabled"/);
    expect(formsOf(page)).toContain("/admin/llm/ocr/enabled: ocr=yes");
    expect(formsOf(page)).not.toContain("/admin/llm/ocr:");
    expect(entryOf(page, "KI")).toContain("OCR aus");

    await post("/admin/llm/ocr/enabled", { ocr: "yes" });
    expect(await get("/admin/llm")).toContain("aria-checked=\"true\"");
  });

  it("does not offer to remove the last OCR language", async () => {
    const refused = await post("/admin/llm/ocr/deu/remove", {});

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Behalte mindestens eine OCR-Sprache.");
  });

  it("shows why a download failed", async () => {
    catalog.fail("ita", "tampered");

    const failed = await post("/admin/llm/ocr", { language: "ita" });

    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain("does not match its checksum");
  });

  it("marks a chosen OCR language whose model is missing, and offers to download it", async () => {
    await post("/admin/llm/ocr", { language: "fra" });
    await rm(join(instance.tessdataDirectory, "fra.traineddata"));

    const page = await get("/admin/llm");

    expect(entryOf(page, "KI")).toContain("fam-navitem__summary--attention");
    expect(page).toContain("Modell fehlt");
    expect(formsOf(page)).toContain("/admin/llm/ocr: language=fra");
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

describe("the Theme of a browser", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
    await instance.post("/setup", { email: "anna@example.org", password, language: "en" });
  });
  afterEach(async () => {
    await instance.close();
  });

  it("is applied before the stylesheets load, and switched by a button on every Agenda", async () => {
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");

    const page = await (await instance.get(`/agendas/${created.id}`)).text();

    expect(page.indexOf('localStorage.getItem("fam-theme")')).toBeGreaterThan(-1);
    expect(page.indexOf('localStorage.getItem("fam-theme")')).toBeLessThan(page.indexOf('href="/static/tokens.css"'));
    expect(page).toContain('class="fam-theme" data-theme-switch="true"');
    expect(page).toContain('aria-label="Appearance: as the device. Switch to light."');
    expect(page).toContain('data-dark="Appearance: dark. Switch to as the device."');
  });
});
