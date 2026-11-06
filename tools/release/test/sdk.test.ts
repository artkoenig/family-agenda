import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyApiChange, describeSdkApi, pluginRunsOn, sdkVersionProblem } from "../src/sdk";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe("the API text of the SDK", () => {
  it("lists what is exported, one member per line, without comments, implementations and the version", () => {
    const api = describeSdkApi(here("fixtures/sdk"));

    expect(api).toBe(
      [
        "// The public API of @family-agenda/source-sdk, written by `pnpm sdk-api`. Do not edit it by hand.",
        "// src/index.ts",
        "export type Identity = {",
        "    id: string;",
        "    version?: string;",
        "};",
        "export declare function isIdentity(value: unknown): value is Identity;",
        "export declare const answer: number;",
        "// src/testing.ts",
        'import type { Identity } from "./index";',
        "export declare function exampleIdentity(): Identity;",
        "",
      ].join("\n"),
    );
  });

  it("is what packages/source-sdk/api.txt holds; after a change to the SDK's API, run `pnpm sdk-api` and raise the version", () => {
    const written = readFileSync(here("../../../packages/source-sdk/api.txt"), "utf8");

    expect(written).toBe(describeSdkApi(here("../../../packages/source-sdk")));
  });
});

describe("what changed in an API text", () => {
  const api = "export type A = {\n    a: string;\n};\nexport declare function f(a: string): void;\n";

  it("sees no change in the same text", () => {
    expect(classifyApiChange(api, api)).toBe("none");
  });

  it("sees an addition in lines that were added", () => {
    const added = api.replace("    a: string;\n", "    a: string;\n    b?: string;\n") + "export declare const c: number;\n";

    expect(classifyApiChange(api, added)).toBe("additive");
  });

  it.each([
    ["a removed member", "export type A = {\n};\nexport declare function f(a: string): void;\n"],
    ["a changed type", "export type A = {\n    a: number;\n};\nexport declare function f(a: string): void;\n"],
    ["a changed signature", "export type A = {\n    a: string;\n};\nexport declare function f(a: string, b: string): void;\n"],
    ["a removed export", "export type A = {\n    a: string;\n};\n"],
  ])("sees a break in %s", (_what, current) => {
    expect(classifyApiChange(api, current)).toBe("breaking");
  });

  it("counts a line that stood twice and is gone once as a removal", () => {
    expect(classifyApiChange("};\n};\n", "};\n")).toBe("breaking");
  });

  it("is not moved by a reordering", () => {
    expect(classifyApiChange("a\nb\n", "b\na\n")).toBe("none");
  });
});

describe("the SDK's version after its API changed", () => {
  const before = "export declare const x: number;\n";
  const added = before + "export declare const y: number;\n";
  const broken = "export declare const x: string;\n";
  const problem = (from: string, to: string, previousApi: string, currentApi: string) =>
    sdkVersionProblem({ version: from, api: previousApi }, { version: to, api: currentApi });

  it("asks for nothing when the API did not change, whether or not the version rose", () => {
    expect(problem("1.0.0", "1.0.0", before, before)).toBeNull();
    expect(problem("1.0.0", "1.0.1", before, before)).toBeNull();
  });

  it("refuses a version that went down", () => {
    expect(problem("1.2.0", "1.1.0", before, before)).toBe("The SDK version went down, from 1.2.0 to 1.1.0.");
  });

  it("asks for a new minor version for an addition, and accepts that or more", () => {
    expect(problem("1.0.0", "1.0.0", before, added)).toContain("Raise it to at least 1.1.0");
    expect(problem("1.0.0", "1.0.1", before, added)).toContain("Raise it to at least 1.1.0");
    expect(problem("1.0.0", "1.1.0", before, added)).toBeNull();
    expect(problem("1.0.0", "2.0.0", before, added)).toBeNull();
  });

  it("asks for a new major version for a break, and accepts only that", () => {
    expect(problem("1.0.0", "1.0.0", before, broken)).toContain("Raise it to at least 2.0.0");
    expect(problem("1.0.0", "1.1.0", before, broken)).toContain("Raise it to at least 2.0.0");
    expect(problem("1.3.2", "2.0.0", before, broken)).toBeNull();
  });

  it("says in its message what happened to the API and what to run", () => {
    expect(problem("1.0.0", "1.0.0", before, broken)).toContain("had something removed or changed");
    expect(problem("1.0.0", "1.0.0", before, added)).toContain("grown");
    expect(problem("1.0.0", "1.0.0", before, added)).toContain("pnpm sdk-api");
  });

  it("lets a 0.x SDK break with a new minor and grow with a new patch", () => {
    expect(problem("0.2.0", "0.2.0", before, broken)).toContain("Raise it to at least 0.3.0");
    expect(problem("0.2.0", "0.3.0", before, broken)).toBeNull();
    expect(problem("0.2.0", "0.2.0", before, added)).toContain("Raise it to at least 0.2.1");
    expect(problem("0.2.0", "0.2.1", before, added)).toBeNull();
  });

  it("refuses a version that is not three numbers", () => {
    expect(() => problem("1.0", "1.0.0", before, before)).toThrow(/no version like 1\.2\.3/);
  });
});

describe("which plugins run on which SDK", () => {
  it.each([
    ["1.0.0", "1.0.0", true],
    ["1.0.0", "1.4.0", true],
    ["1.4.0", "1.0.0", false],
    ["1.0.0", "2.0.0", false],
    ["2.0.0", "1.9.0", false],
    ["0.2.0", "0.2.5", true],
    ["0.2.0", "0.3.0", false],
  ])("a plugin built for %s on SDK %s: %s", (builtFor, running, runs) => {
    expect(pluginRunsOn(builtFor, running)).toBe(runs);
  });
});
