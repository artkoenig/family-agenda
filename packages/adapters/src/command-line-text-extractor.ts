import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Conversion, TextExtractor } from "@family-agenda/application";
import type { OcrLanguage } from "@family-agenda/domain";
import { reason } from "./tool-failure";

const run = promisify(execFile);

export type CommandLineTextExtractorOptions = {
  /** How long one call of a tool may take; OCR of a page takes seconds on a small CPU. */
  timeoutMs?: number;
  /** Where Tesseract finds its models, the `tessdata` volume; by default where it was installed. */
  tessdataDirectory?: string;
};

/** Tesseract reads best at about 300 dpi. */
const ocrDpi = 300;

/**
 * The `TextExtractor` wrapping poppler's `pdftotext` and `pdftoppm` and Tesseract with the models
 * of the `tessdata` volume (ADR-0012). Each call works on a copy of the PDF in its own temporary
 * directory, removed afterwards.
 */
export class CommandLineTextExtractor implements TextExtractor {
  private readonly timeoutMs: number;
  private readonly tessdataDirectory: string | null;

  constructor(options: CommandLineTextExtractorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;
    this.tessdataDirectory = options.tessdataDirectory ?? null;
  }

  textLayer(pdf: Uint8Array): Promise<Conversion<string[]>> {
    return this.withPdf(pdf, async (file) => {
      const text = await this.tool("pdftotext", ["-enc", "UTF-8", "-q", file, "-"]);
      // Each page ends with a form feed.
      const pages = text.split("\f");
      pages.pop();
      return pages;
    });
  }

  ocr(pdf: Uint8Array, pages: number[], languages: OcrLanguage[]): Promise<Conversion<string[]>> {
    const models = this.tessdataDirectory ? ["--tessdata-dir", this.tessdataDirectory] : [];
    return this.withPdf(pdf, async (file, directory) => {
      const texts: string[] = [];
      for (const page of pages) {
        const image = await this.render(file, directory, page, ["-r", String(ocrDpi), "-gray"]);
        texts.push(await this.tool("tesseract", [image, "-", ...models, "-l", languages.join("+")]));
      }
      return texts;
    });
  }

  /** Renders one page to a PNG file in the directory, and returns its path. */
  private async render(file: string, directory: string, page: number, options: string[]): Promise<string> {
    const prefix = join(directory, "page");
    await this.tool("pdftoppm", [...options, "-png", "-singlefile", "-f", String(page), "-l", String(page), file, prefix]);
    return `${prefix}.png`;
  }

  private async tool(command: string, args: string[]): Promise<string> {
    const { stdout } = await run(command, args, { encoding: "utf8", timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  private async withPdf<T>(pdf: Uint8Array, convert: (file: string, directory: string) => Promise<T>): Promise<Conversion<T>> {
    let directory: string | null = null;
    try {
      directory = await mkdtemp(join(tmpdir(), "family-agenda-pdf-"));
      const file = join(directory, "attachment.pdf");
      await writeFile(file, pdf, { mode: 0o600 });
      return { ok: true, value: await convert(file, directory) };
    } catch (error) {
      return { ok: false, message: reason(error) };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
