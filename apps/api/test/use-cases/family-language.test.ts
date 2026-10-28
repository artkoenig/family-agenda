import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { fakeModel, FakeTessdataCatalog } from "../support/fake-tessdata-catalog";

const password = "correct horse battery";

/** When the migration that added the Family Language was generated, as `drizzle/meta/_journal.json` records it. */
const familyLanguagesMigration = 1793119678494;

describe("the Family Language", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("is English with English OCR on an Instance that never chose one", async () => {
    const settings = await instance.app.languages.current();

    expect(settings.language).toBe("en");
    expect(settings.ocrLanguages).toEqual([{ language: "eng", installed: true }]);
  });

  it("is chosen with the first Admin, and OCR reads that language", async () => {
    const created = await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password, language: "de" });
    expect(created.ok).toBe(true);

    const settings = await instance.app.languages.current();
    expect(settings.language).toBe("de");
    expect(settings.ocrLanguages).toEqual([{ language: "deu", installed: true }]);
  });

  it("refuses a first Admin with a language the Instance does not speak", async () => {
    const created = await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password, language: "fr" });

    expect(created).toEqual({ ok: false, problem: "invalid-language" });
    expect(await instance.app.admins.needsFirstAdmin()).toBe(true);
  });

  it("can be changed by an Admin, which leaves the OCR languages as they are", async () => {
    expect(await instance.app.languages.setLanguage("de")).toEqual({ ok: true });
    expect(await instance.app.languages.setLanguage("fr")).toEqual({ ok: false, problem: "invalid-language" });

    const settings = await instance.app.languages.current();
    expect(settings.language).toBe("de");
    expect(settings.ocrLanguages).toEqual([{ language: "eng", installed: true }]);
  });

  it("keeps OCR in German on an Instance set up before there was a Family Language", async () => {
    await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password, language: "en" });
    // As before the migration that added the Family Language, which then runs again on restart, with
    // the later ones undone too: only migrations newer than the last one recorded run.
    await instance.query(`DROP TABLE attribution_rule_members, attribution_rules`);
    await instance.query(`DROP TABLE catalogue_entries`);
    await instance.query(`ALTER TABLE origins DROP COLUMN withdrawn_at`);
    await instance.query(`ALTER TABLE families DROP COLUMN language, DROP COLUMN ocr_languages`);
    await instance.query(
      `ALTER TABLE sources DROP COLUMN last_success_at, DROP COLUMN failing_since, DROP COLUMN last_error_kind, DROP COLUMN last_error, DROP COLUMN last_new_origin_at`,
    );
    await instance.query(`DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${familyLanguagesMigration}`);

    await instance.restart();

    const settings = await instance.app.languages.current();
    expect(settings.language).toBe("en");
    expect(settings.ocrLanguages).toEqual([{ language: "deu", installed: true }]);
  });

  it("survives a restart", async () => {
    await instance.app.languages.setLanguage("de");

    await instance.restart();

    expect((await instance.app.languages.current()).language).toBe("de");
  });
});

describe("the OCR languages", () => {
  let instance: TestInstance;
  let catalog: FakeTessdataCatalog;
  beforeEach(async () => {
    catalog = new FakeTessdataCatalog();
    instance = await bootForTest({ tessdataCatalog: catalog });
  });
  afterEach(async () => {
    await instance.close();
  });

  const models = async () =>
    (await instance.app.languages.current()).models.map((model) =>
      [model.language, model.bundled ? "bundled" : "downloaded", model.selected ? "selected" : ""].join(" ").trim(),
    );

  it("are chosen and ordered among the installed models", async () => {
    expect(await instance.app.languages.setOcrLanguages(["deu", "eng"])).toEqual({ ok: true });

    const settings = await instance.app.languages.current();
    expect(settings.ocrLanguages).toEqual([
      { language: "deu", installed: true },
      { language: "eng", installed: true },
    ]);
    expect(await models()).toEqual(["deu bundled selected", "eng bundled selected"]);
    expect(settings.downloadable).toEqual(["fra", "ita"]);
  });

  it("cannot include a language whose model is not installed, nor be empty", async () => {
    expect(await instance.app.languages.setOcrLanguages(["deu", "fra"])).toEqual({
      ok: false,
      problem: "ocr-language-not-installed",
    });
    expect(await instance.app.languages.setOcrLanguages([])).toEqual({ ok: false, problem: "no-ocr-language" });
    expect((await instance.app.languages.current()).ocrLanguages).toEqual([{ language: "eng", installed: true }]);
  });

  it("can use a model once it is downloaded, and drop it again once unselected", async () => {
    expect(await instance.app.languages.install("fra")).toEqual({ ok: true });
    expect(await instance.app.languages.setOcrLanguages(["fra", "eng"])).toEqual({ ok: true });
    expect(await models()).toEqual(["deu bundled", "eng bundled selected", "fra downloaded selected"]);
    expect(await readFile(join(instance.tessdataDirectory, "fra.traineddata"))).toEqual(Buffer.from(fakeModel("fra")));

    expect(await instance.app.languages.remove("fra")).toEqual({ ok: false, problem: "ocr-language-selected" });
    await instance.app.languages.setOcrLanguages(["eng"]);
    expect(await instance.app.languages.remove("fra")).toEqual({ ok: true });
    expect(await models()).toEqual(["deu bundled", "eng bundled selected"]);
  });

  it("never removes a bundled model", async () => {
    expect(await instance.app.languages.remove("deu")).toEqual({ ok: false, problem: "ocr-language-bundled" });
    expect(await models()).toEqual(["deu bundled", "eng bundled selected"]);
  });

  it("says why a download failed, and leaves nothing behind", async () => {
    catalog.fail("fra", "unreachable");
    catalog.fail("ita", "tampered");

    expect(await instance.app.languages.install("fra")).toEqual({
      ok: false,
      problem: "download-failed",
      message: "getaddrinfo ENOTFOUND raw.githubusercontent.com",
    });
    expect(await instance.app.languages.install("ita")).toMatchObject({
      ok: false,
      problem: "download-failed",
      message: expect.stringContaining("checksum") as unknown,
    });
    expect(await instance.app.languages.install("xyz")).toEqual({ ok: false, problem: "unknown-ocr-language" });
    expect((await readdir(instance.tessdataDirectory)).sort()).toEqual([
      "deu.traineddata",
      "eng.traineddata",
      "osd.traineddata",
    ]);
  });

  it("counts a model an operator put into the volume by hand as installed", async () => {
    await writeFile(join(instance.tessdataDirectory, "ita.traineddata"), fakeModel("ita"));

    expect(await instance.app.languages.setOcrLanguages(["ita"])).toEqual({ ok: true });
    expect(await models()).toEqual(["deu bundled", "eng bundled", "ita downloaded selected"]);
  });

  it("marks a selected language whose model went missing", async () => {
    await instance.app.languages.install("fra");
    await instance.app.languages.setOcrLanguages(["fra"]);
    await rm(join(instance.tessdataDirectory, "fra.traineddata"));

    const settings = await instance.app.languages.current();
    expect(settings.ocrLanguages).toEqual([{ language: "fra", installed: false }]);
    expect(settings.downloadable).toContain("fra");
  });

  it("links the bundled models into the volume again where they are missing", async () => {
    await rm(join(instance.tessdataDirectory, "deu.traineddata"));

    await instance.restart();

    expect(await models()).toEqual(["deu bundled", "eng bundled selected"]);
  });
});
