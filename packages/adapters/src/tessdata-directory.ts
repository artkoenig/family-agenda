import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversion, OcrModel, OcrModelStore } from "@family-agenda/application";
import { isOcrLanguage, type OcrLanguage } from "@family-agenda/domain";

/** Where models are downloaded from, and the checksums they must have. */
export type TessdataCatalog = {
  /** The SHA-256 of each downloadable model, in hex, by its Tesseract code. */
  checksums: ReadonlyMap<string, string>;
  /** The model's file; throws if it cannot be downloaded. */
  download(language: OcrLanguage): Promise<Uint8Array>;
};

export type TessdataDirectoryOptions = {
  /** The `tessdata` volume, passed to Tesseract with `--tessdata-dir`. */
  directory: string;
  /** Where the image keeps the models it ships; null if it ships none. */
  bundledDirectory: string | null;
  catalog: TessdataCatalog;
};

const extension = ".traineddata";

/**
 * The Tesseract models in the `tessdata` volume (ADR-0012). Bundled models are links to the
 * image's own; downloaded ones and those an operator put there by hand are plain files.
 */
export class TessdataDirectory implements OcrModelStore {
  constructor(private readonly options: TessdataDirectoryOptions) {}

  /**
   * Links each bundled model into the volume where it is missing, as on every start. Without
   * Tesseract installed, as outside the image, there is nothing to link.
   */
  async linkBundled(): Promise<void> {
    const { bundledDirectory, directory } = this.options;
    if (!bundledDirectory) return;
    for (const file of await readdir(bundledDirectory).catch(() => [] as string[])) {
      if (!file.endsWith(extension)) continue;
      const target = join(directory, file);
      if (await resolves(target)) continue;
      // A link left dangling by an image that kept its models elsewhere is replaced.
      await unlink(target).catch(() => undefined);
      await symlink(join(bundledDirectory, file), target).catch((error: unknown) => {
        // The api and the worker start together; whichever links it first wins.
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      });
    }
  }

  downloadable(): OcrLanguage[] {
    return [...this.options.catalog.checksums.keys()].filter(isOcrLanguage).sort();
  }

  async installed(): Promise<OcrModel[]> {
    const models: OcrModel[] = [];
    for (const file of (await readdir(this.options.directory)).sort()) {
      const language = file.slice(0, -extension.length);
      if (!file.endsWith(extension) || !isOcrLanguage(language)) continue;
      const path = join(this.options.directory, file);
      if (!(await resolves(path))) continue;
      models.push({ language, bundled: (await lstat(path)).isSymbolicLink() });
    }
    return models;
  }

  async install(language: OcrLanguage): Promise<Conversion<null>> {
    const expected = this.options.catalog.checksums.get(language);
    if (!expected) return { ok: false, message: `No model for ${language} can be downloaded.` };
    let bytes: Uint8Array;
    try {
      bytes = await this.options.catalog.download(language);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "It could not be downloaded." };
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      return { ok: false, message: "The downloaded file does not match its checksum, so it was not kept." };
    }
    // Written beside it and renamed, so that Tesseract never reads half a model.
    const partial = join(this.options.directory, `.${language}.${randomBytes(6).toString("hex")}.part`);
    try {
      await writeFile(partial, bytes);
      await rename(partial, join(this.options.directory, `${language}${extension}`));
      return { ok: true, value: null };
    } catch (error) {
      await rm(partial, { force: true });
      return { ok: false, message: error instanceof Error ? error.message : "It could not be saved." };
    }
  }

  async remove(language: OcrLanguage): Promise<void> {
    const path = join(this.options.directory, `${language}${extension}`);
    const stats = await lstat(path).catch(() => null);
    if (!stats || stats.isSymbolicLink()) return;
    await unlink(path);
  }
}

/** Whether the path is a file, following links. */
async function resolves(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
