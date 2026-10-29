import { isFamilyLanguage, isOcrLanguage, type FamilyLanguage, type OcrLanguage } from "@family-agenda/domain";
import type { FamilyRepository, OcrModelStore } from "./ports";

export type LanguagesDeps = {
  families: FamilyRepository;
  ocrModels: OcrModelStore;
};

export type LanguageSettings = {
  language: FamilyLanguage;
  /** In the order Tesseract tries them, each with whether its model is installed. */
  ocrLanguages: { language: OcrLanguage; installed: boolean }[];
  /** The installed models, by language. */
  models: { language: OcrLanguage; bundled: boolean; selected: boolean }[];
  /** The languages whose model can be downloaded and is not installed. */
  downloadable: OcrLanguage[];
};

export type SetLanguageResult = { ok: true } | { ok: false; problem: "invalid-language" };

export type SetOcrLanguagesResult = { ok: true } | { ok: false; problem: "no-ocr-language" | "ocr-language-not-installed" };

export type InstallResult =
  | { ok: true }
  | { ok: false; problem: "unknown-ocr-language" }
  | { ok: false; problem: "download-failed"; message: string };

export type RemoveModelResult =
  | { ok: true }
  | { ok: false; problem: "unknown-ocr-language" | "ocr-language-selected" | "ocr-language-bundled" };

/** The Family Language, and the OCR languages with the Tesseract models they need (ADR-0012). */
export function createLanguageAccess(deps: LanguagesDeps) {
  const { families, ocrModels } = deps;

  const stored = () => families.languages();

  return {
    /** The language the Instance speaks to the Family in. */
    async familyLanguage(): Promise<FamilyLanguage> {
      return (await stored()).language;
    },

    async current(): Promise<LanguageSettings> {
      const { language, ocrLanguages } = await stored();
      const models = await ocrModels.installed();
      const installed = new Set(models.map((model) => model.language));
      return {
        language,
        ocrLanguages: ocrLanguages.map((ocr) => ({ language: ocr, installed: installed.has(ocr) })),
        models: models.map((model) => ({ ...model, selected: ocrLanguages.includes(model.language) })),
        downloadable: ocrModels.downloadable().filter((ocr) => !installed.has(ocr)),
      };
    },

    /** Changes the language dates are formatted in; the OCR languages stay as they are. */
    async setLanguage(language: string): Promise<SetLanguageResult> {
      if (!isFamilyLanguage(language)) return { ok: false, problem: "invalid-language" };
      const { ocrLanguages } = await stored();
      await families.saveLanguages({ language, ocrLanguages });
      return { ok: true };
    },

    /** Chooses the OCR languages in the order Tesseract tries them; each needs its model installed. */
    async setOcrLanguages(languages: string[]): Promise<SetOcrLanguagesResult> {
      const chosen = [...new Set(languages)];
      if (chosen.length === 0) return { ok: false, problem: "no-ocr-language" };
      const installed = new Set<string>((await ocrModels.installed()).map((model) => model.language));
      const ocrLanguages = chosen.filter(isOcrLanguage).filter((ocr) => installed.has(ocr));
      if (ocrLanguages.length < chosen.length) return { ok: false, problem: "ocr-language-not-installed" };
      const { language } = await stored();
      await families.saveLanguages({ language, ocrLanguages });
      return { ok: true };
    },

    /** Downloads a language's model and checks it against its checksum. */
    async install(language: string): Promise<InstallResult> {
      if (!isOcrLanguage(language) || !ocrModels.downloadable().includes(language)) {
        return { ok: false, problem: "unknown-ocr-language" };
      }
      const installed = await ocrModels.install(language);
      return installed.ok ? { ok: true } : { ok: false, problem: "download-failed", message: installed.message };
    },

    /** Removes a downloaded model that OCR does not use; a bundled one stays. */
    async remove(language: string): Promise<RemoveModelResult> {
      const model = (await ocrModels.installed()).find((candidate) => candidate.language === language);
      if (!model) return { ok: false, problem: "unknown-ocr-language" };
      if (model.bundled) return { ok: false, problem: "ocr-language-bundled" };
      if ((await stored()).ocrLanguages.includes(model.language)) return { ok: false, problem: "ocr-language-selected" };
      await ocrModels.remove(model.language);
      return { ok: true };
    },
  };
}

export type LanguageAccess = ReturnType<typeof createLanguageAccess>;
