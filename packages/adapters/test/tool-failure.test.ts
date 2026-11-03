import { describe, expect, it } from "vitest";
import { reason } from "../src/tool-failure";

describe("what a failed tool said", () => {
  it("says a tool ran too long when it was killed", () => {
    expect(reason({ killed: true })).toBe("Converting it took too long.");
  });

  it("names a tool that is not installed", () => {
    expect(reason({ code: "ENOENT", message: "spawn pdftotext ENOENT" })).toBe("A tool to convert it is not installed: spawn pdftotext ENOENT");
    expect(reason({ code: "ENOENT" })).toBe("A tool to convert it is not installed:");
  });

  it("gives the first line of what the tool printed, without the command line", () => {
    expect(reason({ stderr: "Syntax Error: Couldn't read xref table\nmore\n", message: "Command failed: pdftotext /tmp/x.pdf" })).toBe(
      "Syntax Error: Couldn't read xref table",
    );
  });

  it("falls back when the tool printed nothing", () => {
    expect(reason({ stderr: "  " })).toBe("It could not be converted.");
    expect(reason({ stderr: 1 })).toBe("It could not be converted.");
    expect(reason(new Error("boom"))).toBe("It could not be converted.");
  });
});
