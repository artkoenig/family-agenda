import { createHash } from "node:crypto";
import type { TessdataCatalog } from "@family-agenda/adapters";
import type { OcrLanguage } from "@family-agenda/domain";

/** The stand-in model `FakeTessdataCatalog` downloads for a language. */
export const fakeModel = (language: string) => new TextEncoder().encode(`fake ${language} model`);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Offers `deu`, `eng`, `fra` and `ita` with the checksums of their stand-in models. A language
 * can be made to fail to download, or to download a file that does not match its checksum.
 */
export class FakeTessdataCatalog implements TessdataCatalog {
  readonly checksums = new Map(["deu", "eng", "fra", "ita"].map((language) => [language, sha256(fakeModel(language))]));
  private readonly failing = new Map<string, "unreachable" | "tampered">();

  fail(language: string, how: "unreachable" | "tampered"): void {
    this.failing.set(language, how);
  }

  download(language: OcrLanguage): Promise<Uint8Array> {
    const how = this.failing.get(language);
    if (how === "unreachable") return Promise.reject(new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com"));
    return Promise.resolve(how === "tampered" ? fakeModel(`tampered ${language}`) : fakeModel(language));
  }
}
