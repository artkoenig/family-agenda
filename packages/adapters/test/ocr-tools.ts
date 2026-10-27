import { execFileSync } from "node:child_process";
import type { TestContext } from "vitest";

/** A command-line tool, or Tesseract's German language data, that the PDF tests need. */
export type OcrTool = "pdftotext" | "pdftoppm" | "tesseract" | "deu";

const aptPackage: Record<OcrTool, string> = {
  pdftotext: "poppler-utils",
  pdftoppm: "poppler-utils",
  tesseract: "tesseract-ocr",
  deu: "tesseract-ocr-deu",
};

const describedAs: Record<OcrTool, string> = {
  pdftotext: "pdftotext",
  pdftoppm: "pdftoppm",
  tesseract: "tesseract",
  deu: "Tesseract's German language data (deu)",
};

/** What a tool printed when called, or null when it is not installed. */
function output(command: string, args: string[]): string | null {
  try {
    // Some versions print their version or languages to stderr, so both are read.
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (failed.code === "ENOENT") return null;
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
  }
}

let installed: Set<OcrTool> | undefined;

function installedTools(): Set<OcrTool> {
  if (installed) return installed;
  installed = new Set();
  for (const tool of ["pdftotext", "pdftoppm"] as const) {
    if (output(tool, ["-v"]) !== null) installed.add(tool);
  }
  const languages = output("tesseract", ["--list-langs"]);
  if (languages !== null) {
    installed.add("tesseract");
    if (languages.split(/\s+/).includes("deu")) installed.add("deu");
  }
  return installed;
}

/**
 * Skips the test when a tool it needs is missing, saying which one and how to install it. With
 * `REQUIRE_OCR=true`, as CI sets it, the test fails instead, so OCR is never silently untested.
 */
export function requireOcrTools(context: TestContext, ...tools: OcrTool[]): void {
  const missing = tools.filter((tool) => !installedTools().has(tool));
  if (missing.length === 0) return;
  const packages = [...new Set(missing.map((tool) => aptPackage[tool]))].join(" ");
  const note = `Missing ${missing.map((tool) => describedAs[tool]).join(", ")}; install with: sudo apt-get install ${packages}`;
  if (process.env.REQUIRE_OCR === "true") throw new Error(`${note} (REQUIRE_OCR=true)`);
  context.skip(note);
}
