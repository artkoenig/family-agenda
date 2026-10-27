import type { FamilyLanguage } from "@family-agenda/domain";

/** How the setup and the settings offer each Family Language: in itself, and in English. */
export const familyLanguageNames: Record<FamilyLanguage, string> = { en: "English", de: "Deutsch (German)" };

/** The Family Languages in English, for the settings list. */
const familyLanguagesInEnglish: Record<FamilyLanguage, string> = { en: "English", de: "German" };

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** Tesseract models that are no ISO 639 language, or that `Intl.DisplayNames` does not know. */
const special: Record<string, string> = { chi: "Chinese", frk: "German Fraktur", equ: "Math equations" };

/** What the suffix of a Tesseract code says about its model, such as the script it reads. */
const variants: Record<string, string> = {
  sim: "Simplified",
  tra: "Traditional",
  vert: "vertical",
  latn: "Latin",
  cyrl: "Cyrillic",
  latf: "Fraktur",
  old: "old",
};

/** A Tesseract code named in English, such as "German" or "Chinese (Simplified, vertical)"; the code if unknown. */
export function ocrLanguageName(code: string): string {
  const [base = code, ...suffixes] = code.split("_");
  let name: string | undefined = special[base];
  try {
    name ??= languageNames.of(base);
  } catch {
    // Not a language code at all.
  }
  if (!name) return code;
  const parts = suffixes.map((suffix) => variants[suffix] ?? suffix);
  return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
}

export function familyLanguageInEnglish(language: FamilyLanguage): string {
  return familyLanguagesInEnglish[language];
}

/** Names joined as a sentence says them: "German, English and French". */
export function listed(names: string[]): string {
  return new Intl.ListFormat("en-GB", { type: "conjunction" }).format(names);
}
