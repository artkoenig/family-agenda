import type { Conversion, TextExtractor } from "@family-agenda/application";
import type { OcrLanguage } from "@family-agenda/domain";

/** One page of a fake PDF: with a text layer, or a scan whose words only OCR can read. */
export type FakePage = { text: string } | { scan: string };

/** A fake PDF made of the given pages, which `FakeTextExtractor` reads. */
export function fakePdf(...pages: FakePage[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(pages));
}

/**
 * Reads PDFs made by `fakePdf`; any other file cannot be converted. Remembers which pages it read
 * with OCR, and in which languages.
 */
export class FakeTextExtractor implements TextExtractor {
  readonly ocrPages: number[][] = [];
  readonly ocrLanguages: OcrLanguage[][] = [];

  textLayer(pdf: Uint8Array): Promise<Conversion<string[]>> {
    return Promise.resolve(this.read(pdf, (pages) => pages.map((page) => ("text" in page ? page.text : ""))));
  }

  ocr(pdf: Uint8Array, numbers: number[], languages: OcrLanguage[]): Promise<Conversion<string[]>> {
    this.ocrPages.push(numbers);
    this.ocrLanguages.push(languages);
    return Promise.resolve(this.read(pdf, (pages) => numbers.map((number) => scanOf(pages[number - 1]))));
  }

  private read<T>(pdf: Uint8Array, convert: (pages: FakePage[]) => T): Conversion<T> {
    try {
      return { ok: true, value: convert(JSON.parse(new TextDecoder().decode(pdf)) as FakePage[]) };
    } catch {
      return { ok: false, message: "Syntax Error: Couldn't find trailer dictionary" };
    }
  }
}

function scanOf(page: FakePage | undefined): string {
  return page && "scan" in page ? page.scan : "";
}
