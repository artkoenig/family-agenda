/** The languages the Instance speaks to the Family in and formats dates in. */
export const familyLanguages = ["en", "de"] as const;

export type FamilyLanguage = (typeof familyLanguages)[number];

/** The Family Language of an Instance that never chose one. */
export const defaultFamilyLanguage: FamilyLanguage = "en";

export function isFamilyLanguage(text: string): text is FamilyLanguage {
  return (familyLanguages as readonly string[]).includes(text);
}

/** The locale dates are formatted in; the language decides the region too. */
export function localeOf(language: FamilyLanguage): string {
  return language === "de" ? "de-DE" : "en-GB";
}

/** The Tesseract code of a language model, such as `deu`, `chi_sim` or `deu_latf`. */
export type OcrLanguage = string & { readonly __brand: "OcrLanguage" };

/** `osd` detects orientation and script; Tesseract needs it, but it reads no language. */
export function isOcrLanguage(text: string): text is OcrLanguage {
  return /^[a-z]{3}(_[a-z]+)*$/.test(text) && text !== "osd";
}

/** The OCR language a Family Language starts with. */
export function ocrLanguageOf(language: FamilyLanguage): OcrLanguage {
  return (language === "de" ? "deu" : "eng") as OcrLanguage;
}

/** The Family Language and the ordered OCR languages, which Tesseract tries together. */
export type FamilyLanguages = { language: FamilyLanguage; ocrLanguages: OcrLanguage[] };
