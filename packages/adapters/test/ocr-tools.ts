import { execFileSync } from "node:child_process";
import type { TestContext } from "vitest";

/** A command-line tool, or Tesseract's German or English language data, that the PDF tests need. */
export type OcrRequirement = "pdftotext" | "pdftoppm" | "tesseract" | "deu" | "eng";

const requirements: Record<OcrRequirement, { name: string; aptPackage: string }> = {
  pdftotext: { name: "pdftotext", aptPackage: "poppler-utils" },
  pdftoppm: { name: "pdftoppm", aptPackage: "poppler-utils" },
  tesseract: { name: "tesseract", aptPackage: "tesseract-ocr" },
  deu: { name: "Tesseract's German language data (deu)", aptPackage: "tesseract-ocr-deu" },
  eng: { name: "Tesseract's English language data (eng)", aptPackage: "tesseract-ocr-eng" },
};

/** What a tool printed when called, or null when it is not installed. */
function probe(command: string, args: string[]): string | null {
  try {
    // Some versions print their version or languages to stderr, so both are read.
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (failed.code === "ENOENT") return null;
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
  }
}

let installed: Set<OcrRequirement> | undefined;
let tessdata: string | null = null;

function installedRequirements(): Set<OcrRequirement> {
  if (installed) return installed;
  installed = new Set();
  for (const tool of ["pdftotext", "pdftoppm"] as const) {
    if (probe(tool, ["-v"]) !== null) installed.add(tool);
  }
  const languages = probe("tesseract", ["--list-langs"]);
  if (languages !== null) {
    installed.add("tesseract");
    for (const language of ["deu", "eng"] as const) {
      if (languages.split(/\s+/).includes(language)) installed.add(language);
    }
    // It starts with: List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (3):
    tessdata = /"([^"]+)"/.exec(languages)?.[1] ?? null;
  }
  return installed;
}

/**
 * Skips the test when a tool it needs is missing, saying which one and how to install it. With
 * `REQUIRE_OCR=true`, as the run inside the image sets it, the test fails instead, so OCR is never
 * silently untested.
 */
export function requireOcrTools(context: TestContext, ...needs: OcrRequirement[]): void {
  const missing = needs.filter((need) => !installedRequirements().has(need));
  if (missing.length === 0) return;
  const packages = [...new Set(missing.map((need) => requirements[need].aptPackage))].join(" ");
  const note = `Missing ${missing.map((need) => requirements[need].name).join(", ")}; install with: sudo apt-get install ${packages}`;
  if (process.env.REQUIRE_OCR === "true") throw new Error(`${note} (REQUIRE_OCR=true)`);
  context.skip(note);
}

/** Where Tesseract keeps the models it was installed with; call `requireOcrTools` first. */
export function installedTessdataDirectory(): string {
  installedRequirements();
  if (!tessdata) throw new Error("Tesseract does not say where its models are.");
  return tessdata;
}
