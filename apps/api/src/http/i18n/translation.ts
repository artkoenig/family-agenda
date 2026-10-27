import { localeOf, textIn, type FamilyLanguage, type MultilingualText } from "@family-agenda/domain";
import { createContext, useContext } from "hono/jsx";
import { de } from "./de";
import { en, type Catalogue } from "./en";

const catalogues: Record<FamilyLanguage, Catalogue> = { en, de };

/** How the pages speak to the Family: in the Family Language, with dates in its locale. */
export type Translation = {
  language: FamilyLanguage;
  /** The locale dates and numbers are formatted in, such as `de-DE`. */
  locale: string;
  /** The catalogue of the Family Language. */
  t: Catalogue;
  /** A plugin's text in the Family Language, in English if it has none. */
  text: (text: MultilingualText) => string;
  /** Names joined as a sentence says them: "German, English and French". */
  list: (names: string[]) => string;
  /** A Tesseract code named in the Family Language, such as "German" or "Chinese (Simplified, vertical)"; the code if unknown. */
  ocrLanguageName: (code: string) => string;
};

export function translationFor(language: FamilyLanguage): Translation {
  const locale = localeOf(language);
  const t = catalogues[language];
  const listFormat = new Intl.ListFormat(locale, { type: "conjunction" });
  const languageNames = new Intl.DisplayNames([locale], { type: "language", fallback: "none" });
  return {
    language,
    locale,
    t,
    text: (text) => textIn(text, language),
    list: (names) => listFormat.format(names),
    ocrLanguageName: (code) => {
      const [base = code, ...suffixes] = code.split("_");
      let name: string | undefined = t.ocrLanguages.special[base];
      try {
        name ??= languageNames.of(base);
      } catch {
        // Not a language code at all.
      }
      if (!name) return code;
      const parts = suffixes.map((suffix) => t.ocrLanguages.variants[suffix] ?? suffix);
      return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
    },
  };
}

/** The Translation a page is rendered in, provided around it by the app. */
export const TranslationContext = createContext<Translation>(translationFor("en"));

/** The Translation of the page being rendered. */
export function useTranslation(): Translation {
  return useContext(TranslationContext);
}
