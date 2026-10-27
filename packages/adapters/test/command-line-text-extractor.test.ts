import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcrLanguage } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { CommandLineTextExtractor } from "../src";
import { installedTessdataDirectory, requireOcrTools } from "./ocr-tools";

const fixture = async (name: string) => new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)));

/** A PDF's text with its whitespace collapsed, as the evidence check reads it. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const german = ["deu" as OcrLanguage];

const png = [0x89, 0x50, 0x4e, 0x47];

describe("the poppler and Tesseract command-line tools", () => {
  const extractor = new CommandLineTextExtractor();

  it("reads the text layer of a PDF through poppler", async (context) => {
    requireOcrTools(context, "pdftotext");
    const result = await extractor.textLayer(await fixture("text-layer.pdf"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(flat(result.value[0]!)).toContain(
      "der Wandertag der Klasse 5b findet am Freitag, 25.09., statt. Treffpunkt ist um 8:00 Uhr am Bahnhof.",
    );
    expect(result.value[0]).toContain("Frau Müller");
  });

  it("finds no text layer on a scanned PDF", async (context) => {
    requireOcrTools(context, "pdftotext");
    const result = await extractor.textLayer(await fixture("scan.pdf"));

    expect(result).toEqual({ ok: true, value: [""] });
  });

  it("reads a scanned PDF with Tesseract in German", async (context) => {
    requireOcrTools(context, "pdftoppm", "tesseract", "deu");
    const result = await extractor.ocr(await fixture("scan.pdf"), [1], german);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flat(result.value[0]!)).toContain(
      "das Sommerfest der Grundschule findet am Samstag, 26.09., von 14:00 bis 17:00 Uhr auf dem Schulhof statt.",
    );
    expect(result.value[0]).toContain("Viele Grüße");
  });

  it("reads a scanned English letter with Tesseract in German and English together", async (context) => {
    requireOcrTools(context, "pdftoppm", "tesseract", "deu", "eng");
    const result = await extractor.ocr(await fixture("scan-english.pdf"), [1], ["deu", "eng"] as OcrLanguage[]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flat(result.value[0]!)).toContain("the school trip of class 5b takes place on Friday, 25 September.");
    expect(flat(result.value[0]!)).toContain("We meet at 8:00 at the station");
  });

  it("reads with the models of the given tessdata directory only", async (context) => {
    requireOcrTools(context, "pdftoppm", "tesseract", "eng");
    const tessdata = await mkdtemp(join(tmpdir(), "family-agenda-tessdata-"));
    try {
      await symlink(join(installedTessdataDirectory(), "eng.traineddata"), join(tessdata, "eng.traineddata"));
      const volume = new CommandLineTextExtractor({ tessdataDirectory: tessdata });
      const scan = await fixture("scan-english.pdf");

      const english = await volume.ocr(scan, [1], ["eng"] as OcrLanguage[]);
      expect(english.ok && flat(english.value[0]!)).toContain("Please bring a packed lunch and a raincoat.");
      const withoutModel = await volume.ocr(scan, [1], german);
      expect(withoutModel).toMatchObject({ ok: false, message: expect.stringContaining("deu") as unknown });
    } finally {
      await rm(tessdata, { recursive: true, force: true });
    }
  });

  it("renders the pages of a scanned PDF as PNG images", async (context) => {
    requireOcrTools(context, "pdftoppm");
    const result = await extractor.pageImages(await fixture("scan.pdf"), [1]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect([...result.value[0]!.subarray(0, 4)]).toEqual(png);
  });

  it("says why a file that is no PDF cannot be converted", async (context) => {
    // Without the tools it would pass on "not installed" alone.
    requireOcrTools(context, "pdftotext", "pdftoppm");
    const broken = new TextEncoder().encode("this is no PDF");

    for (const result of [
      await extractor.textLayer(broken),
      await extractor.ocr(broken, [1], german),
      await extractor.pageImages(broken, [1]),
    ]) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/\S/) as unknown });
    }
  });
});
