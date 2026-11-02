import { describe, it, expect } from "vitest";
import { isFamilyLanguage, localeOf, isOcrLanguage, ocrLanguageOf, textIn, defaultFamilyLanguage, type MultilingualText } from "../src/language";

describe("isFamilyLanguage", () => {
  it("accepts 'en'", () => {
    expect(isFamilyLanguage("en")).toBe(true);
  });

  it("accepts 'de'", () => {
    expect(isFamilyLanguage("de")).toBe(true);
  });

  it("rejects 'fr'", () => {
    expect(isFamilyLanguage("fr")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isFamilyLanguage("")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isFamilyLanguage("EN")).toBe(false);
  });
});

describe("localeOf", () => {
  it("returns 'en-GB' for English", () => {
    expect(localeOf("en")).toBe("en-GB");
  });

  it("returns 'de-DE' for German", () => {
    expect(localeOf("de")).toBe("de-DE");
  });
});

describe("isOcrLanguage", () => {
  it("accepts 'deu' (3-letter code)", () => {
    expect(isOcrLanguage("deu")).toBe(true);
  });

  it("accepts 'eng' (3-letter code)", () => {
    expect(isOcrLanguage("eng")).toBe(true);
  });

  it("accepts 'chi_sim' (with underscore suffix)", () => {
    expect(isOcrLanguage("chi_sim")).toBe(true);
  });

  it("accepts 'deu_latf' (with underscore suffix)", () => {
    expect(isOcrLanguage("deu_latf")).toBe(true);
  });

  it("rejects 'osd' (orientation detection, not a language)", () => {
    expect(isOcrLanguage("osd")).toBe(false);
  });

  it("rejects 2-character strings", () => {
    expect(isOcrLanguage("de")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isOcrLanguage("DEU")).toBe(false);
  });

  it("rejects strings with spaces", () => {
    expect(isOcrLanguage("deu sim")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isOcrLanguage("")).toBe(false);
  });

  it("rejects strings starting with underscore", () => {
    expect(isOcrLanguage("_deu")).toBe(false);
  });
});

describe("ocrLanguageOf", () => {
  it("returns 'eng' for English", () => {
    expect(ocrLanguageOf("en")).toBe("eng");
  });

  it("returns 'deu' for German", () => {
    expect(ocrLanguageOf("de")).toBe("deu");
  });
});

describe("textIn", () => {
  it("returns the string as-is for plain strings", () => {
    expect(textIn("Hello", "en")).toBe("Hello");
  });

  it("returns the requested language from an object", () => {
    const text: MultilingualText = { en: "Calendar", de: "Kalender" };
    expect(textIn(text, "de")).toBe("Kalender");
  });

  it("falls back to English when the requested language is missing", () => {
    const text: MultilingualText = { en: "Calendar" };
    expect(textIn(text, "de")).toBe("Calendar");
  });

  it("returns English for English request", () => {
    const text: MultilingualText = { en: "Calendar", de: "Kalender" };
    expect(textIn(text, "en")).toBe("Calendar");
  });
});

describe("defaultFamilyLanguage", () => {
  it("is English", () => {
    expect(defaultFamilyLanguage).toBe("en");
  });
});
