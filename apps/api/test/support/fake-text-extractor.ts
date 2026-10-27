import type { Conversion, TextExtractor } from "@family-agenda/application";

/** One page of a fake PDF: with a text layer, or a scan whose words only OCR or a model can read. */
export type FakePage = { text: string } | { scan: string };

/** A fake PDF made of the given pages, which `FakeTextExtractor` reads. */
export function fakePdf(...pages: FakePage[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(pages));
}

/** A page image of a scan as `FakeTextExtractor` renders it: the scan's words, for a scripted model. */
export function scanImageText(image: Uint8Array): string {
  return new TextDecoder().decode(image);
}

/**
 * Reads PDFs made by `fakePdf`; any other file cannot be converted. Remembers which pages it read
 * with OCR and rendered as images.
 */
export class FakeTextExtractor implements TextExtractor {
  readonly ocrPages: number[][] = [];
  readonly renderedPages: number[][] = [];

  textLayer(pdf: Uint8Array): Promise<Conversion<string[]>> {
    return Promise.resolve(this.read(pdf, (pages) => pages.map((page) => ("text" in page ? page.text : ""))));
  }

  pageImages(pdf: Uint8Array, numbers: number[]): Promise<Conversion<Uint8Array[]>> {
    this.renderedPages.push(numbers);
    return Promise.resolve(
      this.read(pdf, (pages) => numbers.map((number) => new TextEncoder().encode(scanOf(pages[number - 1])))),
    );
  }

  ocr(pdf: Uint8Array, numbers: number[]): Promise<Conversion<string[]>> {
    this.ocrPages.push(numbers);
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
