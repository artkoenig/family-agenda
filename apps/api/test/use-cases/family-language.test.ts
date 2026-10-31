import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { fakeModel, FakeTessdataCatalog } from "../support/fake-tessdata-catalog";

const password = "correct horse battery";

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

  const listed = async () => (await instance.app.languages.current()).ocrLanguages.map((ocr) => ocr.language);
  const volume = async () => (await readdir(instance.tessdataDirectory)).sort();

  it("are added after the others, with a bundled model at once", async () => {
    expect(await instance.app.languages.addOcrLanguage("deu")).toEqual({ ok: true });

    const settings = await instance.app.languages.current();
    expect(settings.ocrLanguages).toEqual([
      { language: "eng", installed: true },
      { language: "deu", installed: true },
    ]);
    expect(settings.addable).toEqual(["fra", "ita"]);
  });

  it("are ordered by moving one up, and the first cannot move further", async () => {
    await instance.app.languages.addOcrLanguage("deu");

    expect(await instance.app.languages.moveOcrLanguageUp("deu")).toEqual({ ok: true });
    expect(await listed()).toEqual(["deu", "eng"]);
    expect(await instance.app.languages.moveOcrLanguageUp("deu")).toEqual({ ok: true });
    expect(await listed()).toEqual(["deu", "eng"]);
    expect(await instance.app.languages.moveOcrLanguageUp("fra")).toEqual({ ok: false, problem: "unknown-ocr-language" });
  });

  it("download a model when a language is added, and delete it when the language is removed", async () => {
    expect(await instance.app.languages.addOcrLanguage("fra")).toEqual({ ok: true });
    expect(await listed()).toEqual(["eng", "fra"]);
    expect(await readFile(join(instance.tessdataDirectory, "fra.traineddata"))).toEqual(Buffer.from(fakeModel("fra")));

    expect(await instance.app.languages.removeOcrLanguage("fra")).toEqual({ ok: true });
    expect(await listed()).toEqual(["eng"]);
    expect(await volume()).toEqual(["deu.traineddata", "eng.traineddata", "osd.traineddata"]);
    expect((await instance.app.languages.current()).addable).toContain("fra");
  });

  it("can drop a bundled language and add it again without a download", async () => {
    await instance.app.languages.addOcrLanguage("deu");

    expect(await instance.app.languages.removeOcrLanguage("eng")).toEqual({ ok: true });
    expect(await listed()).toEqual(["deu"]);
    expect(await volume()).toContain("eng.traineddata");

    catalog.fail("eng", "unreachable");
    expect(await instance.app.languages.addOcrLanguage("eng")).toEqual({ ok: true });
    expect(await listed()).toEqual(["deu", "eng"]);
  });

  it("keep at least one language", async () => {
    expect(await instance.app.languages.removeOcrLanguage("eng")).toEqual({ ok: false, problem: "no-ocr-language" });
    expect(await instance.app.languages.removeOcrLanguage("fra")).toEqual({ ok: false, problem: "unknown-ocr-language" });
    expect(await listed()).toEqual(["eng"]);
  });

  it("say why a download failed, and leave nothing behind", async () => {
    catalog.fail("fra", "unreachable");
    catalog.fail("ita", "tampered");

    expect(await instance.app.languages.addOcrLanguage("fra")).toEqual({
      ok: false,
      problem: "download-failed",
      message: "getaddrinfo ENOTFOUND raw.githubusercontent.com",
    });
    expect(await instance.app.languages.addOcrLanguage("ita")).toMatchObject({
      ok: false,
      problem: "download-failed",
      message: expect.stringContaining("checksum") as unknown,
    });
    expect(await instance.app.languages.addOcrLanguage("xyz")).toEqual({ ok: false, problem: "unknown-ocr-language" });
    expect(await listed()).toEqual(["eng"]);
    expect(await volume()).toEqual(["deu.traineddata", "eng.traineddata", "osd.traineddata"]);
  });

  it("count a model an operator put into the volume by hand as installed", async () => {
    await writeFile(join(instance.tessdataDirectory, "ita.traineddata"), fakeModel("ita"));
    catalog.fail("ita", "unreachable");

    expect(await instance.app.languages.addOcrLanguage("ita")).toEqual({ ok: true });
    expect(await listed()).toEqual(["eng", "ita"]);
  });

  it("mark a language whose model went missing, which is downloaded again or removed", async () => {
    await instance.app.languages.addOcrLanguage("fra");
    await rm(join(instance.tessdataDirectory, "fra.traineddata"));

    expect((await instance.app.languages.current()).ocrLanguages).toEqual([
      { language: "eng", installed: true },
      { language: "fra", installed: false },
    ]);

    expect(await instance.app.languages.addOcrLanguage("fra")).toEqual({ ok: true });
    expect(await listed()).toEqual(["eng", "fra"]);
    expect((await instance.app.languages.current()).ocrLanguages[1]).toEqual({ language: "fra", installed: true });

    await rm(join(instance.tessdataDirectory, "fra.traineddata"));
    expect(await instance.app.languages.removeOcrLanguage("fra")).toEqual({ ok: true });
    expect(await listed()).toEqual(["eng"]);
  });

  it("link the bundled models into the volume again where they are missing", async () => {
    await rm(join(instance.tessdataDirectory, "deu.traineddata"));

    await instance.restart();

    expect(await volume()).toEqual(["deu.traineddata", "eng.traineddata", "osd.traineddata"]);
  });
});
