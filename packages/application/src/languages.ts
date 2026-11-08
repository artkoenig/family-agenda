import { isFamilyLanguage, isOcrLanguage, type FamilyLanguage, type OcrLanguage } from "@family-agenda/domain";
import type { FamilyRepository, OcrModelStore } from "./ports";

export type LanguagesDeps = {
  families: FamilyRepository;
  ocrModels: OcrModelStore;
};

export type LanguageSettings = {
  language: FamilyLanguage;
  /** Whether OCR reads scanned pages; the LLM only ever receives text. */
  ocrEnabled: boolean;
  /** In the order Tesseract tries them, each with whether its model is installed. */
  ocrLanguages: { language: OcrLanguage; installed: boolean }[];
  /** The languages that can be added: their model is installed or can be downloaded. */
  addable: OcrLanguage[];
};

export type SetLanguageResult = { ok: true } | { ok: false; problem: "invalid-language" };

export type AddOcrLanguageResult =
  | { ok: true }
  | { ok: false; problem: "unknown-ocr-language" }
  | { ok: false; problem: "download-failed"; message: string };

export type ChangeOcrLanguagesResult = { ok: true } | { ok: false; problem: "unknown-ocr-language" | "no-ocr-language" };

/**
 * The Family Language, and the OCR languages. A language in the list is read with, and
 * its Tesseract model comes and goes with it.
 */
export function createLanguageAccess(deps: LanguagesDeps) {
  const { families, ocrModels } = deps;

  const stored = () => families.languages();

  const saveOcrLanguages = async (ocrLanguages: OcrLanguage[]) => {
    const { language } = await stored();
    await families.saveLanguages({ language, ocrLanguages });
  };

  return {
    /** The language the Instance speaks to the Family in. */
    async familyLanguage(): Promise<FamilyLanguage> {
      return (await stored()).language;
    },

    async current(): Promise<LanguageSettings> {
      const { language, ocrLanguages } = await stored();
      const installed = new Set((await ocrModels.installed()).map((model) => model.language));
      const addable = new Set([...installed, ...ocrModels.downloadable()]);
      return {
        language,
        ocrEnabled: await families.ocrEnabled(),
        ocrLanguages: ocrLanguages.map((ocr) => ({ language: ocr, installed: installed.has(ocr) })),
        addable: [...addable].filter((ocr) => !ocrLanguages.includes(ocr)).sort(),
      };
    },

    /** Changes the language dates are formatted in; the OCR languages stay as they are. */
    async setLanguage(language: string): Promise<SetLanguageResult> {
      if (!isFamilyLanguage(language)) return { ok: false, problem: "invalid-language" };
      const { ocrLanguages } = await stored();
      await families.saveLanguages({ language, ocrLanguages });
      return { ok: true };
    },

    /** Switches OCR on or off, whatever the LLM endpoint's model can do. */
    async setOcrEnabled(enabled: boolean): Promise<void> {
      await families.saveOcrEnabled(enabled);
    },

    /**
     * Adds a language after the others, downloading its model where it is not installed. A language
     * that is already in the list only has its missing model downloaded again.
     */
    async addOcrLanguage(language: string): Promise<AddOcrLanguageResult> {
      if (!isOcrLanguage(language)) return { ok: false, problem: "unknown-ocr-language" };
      const installed = (await ocrModels.installed()).some((model) => model.language === language);
      if (!installed) {
        if (!ocrModels.downloadable().includes(language)) return { ok: false, problem: "unknown-ocr-language" };
        const downloaded = await ocrModels.install(language);
        if (!downloaded.ok) return { ok: false, problem: "download-failed", message: downloaded.message };
      }
      const { ocrLanguages } = await stored();
      if (!ocrLanguages.includes(language)) await saveOcrLanguages([...ocrLanguages, language]);
      return { ok: true };
    },

    /** Drops a language, and its model unless it comes with the image. The last one stays. */
    async removeOcrLanguage(language: string): Promise<ChangeOcrLanguagesResult> {
      const { ocrLanguages } = await stored();
      const dropped = ocrLanguages.find((ocr) => ocr === language);
      if (!dropped) return { ok: false, problem: "unknown-ocr-language" };
      if (ocrLanguages.length === 1) return { ok: false, problem: "no-ocr-language" };
      await saveOcrLanguages(ocrLanguages.filter((ocr) => ocr !== dropped));
      await ocrModels.remove(dropped);
      return { ok: true };
    },

    /** Has Tesseract try a language before the one that was tried before it. */
    async moveOcrLanguageUp(language: string): Promise<ChangeOcrLanguagesResult> {
      const { ocrLanguages } = await stored();
      const index = ocrLanguages.findIndex((ocr) => ocr === language);
      if (index < 0) return { ok: false, problem: "unknown-ocr-language" };
      if (index > 0) {
        const reordered = [...ocrLanguages];
        reordered.splice(index - 1, 2, ocrLanguages[index] as OcrLanguage, ocrLanguages[index - 1] as OcrLanguage);
        await saveOcrLanguages(reordered);
      }
      return { ok: true };
    },
  };
}

export type LanguageAccess = ReturnType<typeof createLanguageAccess>;
