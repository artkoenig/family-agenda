import { readFileSync } from "node:fs";
import type { OcrLanguage } from "@family-agenda/domain";
import type { TessdataCatalog } from "./tessdata-directory";

/** The commit of `tesseract-ocr/tessdata_fast` models are downloaded from. */
export const tessdataFastCommit = "87416418657359cb625c412a48b6e1d6d41c29bd";

/** The largest model is about 12 MB; anything much larger is not one. */
const maximumModelBytes = 64 * 1024 * 1024;

/** Reads `sha256sum` output: a hash and a file name per line, comments starting with `#`. */
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [, hash, language] = /^([0-9a-f]{64}) [ *]?(\S+)\.traineddata$/.exec(line.trim()) ?? [];
    if (hash && language) checksums.set(language, hash);
  }
  return checksums;
}

/**
 * The models of `tessdata_fast` at the pinned commit, with the checksums shipped in
 * `tessdata/tessdata-fast.sha256`.
 */
export function tessdataFastCatalog(options: { timeoutMs?: number } = {}): TessdataCatalog {
  const checksums = parseChecksums(readFileSync(new URL("../tessdata/tessdata-fast.sha256", import.meta.url), "utf8"));
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  return {
    checksums,
    async download(language: OcrLanguage): Promise<Uint8Array> {
      const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${tessdataFastCommit}/${language}.traineddata`;
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}.`.replace(" .", "."));
      if (Number(response.headers.get("content-length") ?? 0) > maximumModelBytes) {
        throw new Error("The file is too large for a model.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maximumModelBytes) throw new Error("The file is too large for a model.");
      return bytes;
    },
  };
}
