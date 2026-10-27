import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcrLanguage } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TessdataDirectory, tessdataFastCatalog, type TessdataCatalog } from "../src";

const model = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("the Tesseract models in the tessdata volume", () => {
  let root: string;
  let volume: string;
  let bundled: string;
  /** What the catalog hands out per language; the checksums are those of the genuine models. */
  let served: Record<string, Uint8Array | Error>;
  let store: TessdataDirectory;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agenda-tessdata-"));
    volume = join(root, "volume");
    bundled = join(root, "bundled");
    await mkdir(volume);
    await mkdir(bundled);
    for (const language of ["deu", "eng", "osd"]) await writeFile(join(bundled, `${language}.traineddata`), `${language} model`);
    served = { fra: model("fra model") };
    const catalog: TessdataCatalog = {
      checksums: new Map([["fra", sha256(model("fra model"))]]),
      download: (language) => {
        const answer = served[language];
        return answer instanceof Error || answer === undefined
          ? Promise.reject(answer ?? new Error("404"))
          : Promise.resolve(answer);
      },
    };
    store = new TessdataDirectory({ directory: volume, bundledDirectory: bundled, catalog });
    await store.linkBundled();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fra = "fra" as OcrLanguage;

  it("keeps a downloaded model whose checksum matches", async () => {
    expect(await store.install(fra)).toEqual({ ok: true, value: null });

    expect(await readFile(join(volume, "fra.traineddata"), "utf8")).toBe("fra model");
    expect(await store.installed()).toEqual([
      { language: "deu", bundled: true },
      { language: "eng", bundled: true },
      { language: "fra", bundled: false },
    ]);
  });

  it("keeps nothing of a download that does not match its checksum, or fails", async () => {
    served.fra = model("fra model, tampered with");
    expect(await store.install(fra)).toEqual({
      ok: false,
      message: "The downloaded file does not match its checksum, so it was not kept.",
    });

    served.fra = new Error("socket hang up");
    expect(await store.install(fra)).toEqual({ ok: false, message: "socket hang up" });

    expect((await readdir(volume)).sort()).toEqual(["deu.traineddata", "eng.traineddata", "osd.traineddata"]);
  });

  it("removes a downloaded model, but never a bundled one", async () => {
    await store.install(fra);

    await store.remove(fra);
    await store.remove("deu" as OcrLanguage);

    expect((await readdir(volume)).sort()).toEqual(["deu.traineddata", "eng.traineddata", "osd.traineddata"]);
  });

  it("offers the models of tessdata_fast with the checksums shipped in the image, osd aside", () => {
    const catalog = tessdataFastCatalog();
    const shipped = new TessdataDirectory({ directory: volume, bundledDirectory: null, catalog });

    expect(catalog.checksums.get("eng")).toBe("7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2");
    expect(shipped.downloadable()).toEqual(expect.arrayContaining(["deu", "eng", "fra", "chi_sim", "deu_latf"]));
    expect(shipped.downloadable()).not.toContain("osd");
  });
});
