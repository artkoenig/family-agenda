import { describe, expect, it } from "vitest";
import { safeFileName } from "../src/family-export";

describe("the file name of an attachment in the Export", () => {
  it("keeps a plain name as it is", () => {
    expect(safeFileName("Elternbrief 5b.pdf")).toBe("Elternbrief 5b.pdf");
  });

  it("leaves no folder, no character some systems refuse, and no leading dot", () => {
    expect(safeFileName("../a\\b:c*d?e\"f<g>h|i\u0000j.pdf")).toBe("_a_b_c_d_e_f_g_h_i_j.pdf");
    expect(safeFileName(" .hidden")).toBe("hidden");
  });

  it("keeps the end of a long name, where its extension is", () => {
    const name = `${"x".repeat(200)}.pdf`;

    expect(safeFileName(name)).toHaveLength(100);
    expect(safeFileName(name).endsWith(".pdf")).toBe(true);
  });

  it("names a file that has no usable name", () => {
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("...")).toBe("file");
  });
});
