import { describe, expect, it } from "vitest";
import { classifyContractChange, contractVersionProblem, type Oasdiff } from "../src/contract";

const document = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ openapi: "3.0.3", info: { title: "contract", version }, paths: {}, ...extra });

describe("what changed in the contract, as oasdiff tells it", () => {
  const oasdiff = (breaking: boolean, changed: boolean) => {
    const calls: { command: string; base: string; revision: string }[] = [];
    const run: Oasdiff = (command, base, revision) => {
      calls.push({ command, base, revision });
      return command === "breaking" ? breaking : changed;
    };
    return { run, calls };
  };

  it("is breaking where oasdiff finds a breaking change", () => {
    expect(classifyContractChange(document("1.0"), document("1.0"), oasdiff(true, true).run)).toBe("breaking");
  });

  it("is additive where something changed that breaks nothing", () => {
    expect(classifyContractChange(document("1.0"), document("1.0"), oasdiff(false, true).run)).toBe("additive");
  });

  it("is none where nothing changed", () => {
    expect(classifyContractChange(document("1.0"), document("1.0"), oasdiff(false, false).run)).toBe("none");
  });

  it("compares the documents without their versions, so that raising the version is no change", () => {
    const { run, calls } = oasdiff(false, false);

    classifyContractChange(document("1.0"), document("1.1", { paths: { "/poll": {} } }), run);

    expect(calls.map((call) => call.command)).toEqual(["breaking", "changelog"]);
    const parse = (text: string) => JSON.parse(text) as { info: { version: string }; paths: unknown };
    for (const call of calls) {
      expect(parse(call.base).info.version).toBe("0.0");
      expect(parse(call.revision).info.version).toBe("0.0");
      expect(parse(call.revision).paths).toEqual({ "/poll": {} });
    }
  });
});

describe("the contract version after the contract changed", () => {
  it("asks for nothing when nothing changed", () => {
    expect(contractVersionProblem("1.0", "1.0", "none")).toBeNull();
    expect(contractVersionProblem("1.0", "1.1", "none")).toBeNull();
  });

  it("refuses a version that went down", () => {
    expect(contractVersionProblem("1.2", "1.1", "none")).toBe("The plugin contract version went down, from 1.2 to 1.1.");
    expect(contractVersionProblem("2.0", "1.9", "none")).toBe("The plugin contract version went down, from 2.0 to 1.9.");
  });

  it("asks for a new minor for an addition, and accepts that or a new major", () => {
    expect(contractVersionProblem("1.0", "1.0", "additive")).toBe(
      "The plugin contract has grown since the last release, but contractVersion is still 1.0 (was 1.0). Raise it to at least 1.1 in packages/plugin-contract/src/index.ts, and run `pnpm openapi`.",
    );
    expect(contractVersionProblem("1.0", "1.1", "additive")).toBeNull();
    expect(contractVersionProblem("1.0", "2.0", "additive")).toBeNull();
  });

  it("asks for a new major for a break, and accepts only that", () => {
    expect(contractVersionProblem("1.3", "1.4", "breaking")).toBe(
      "The plugin contract had something removed or changed since the last release, but contractVersion is still 1.4 (was 1.3). Raise it to at least 2.0 in packages/plugin-contract/src/index.ts, and run `pnpm openapi`.",
    );
    expect(contractVersionProblem("1.3", "2.0", "breaking")).toBeNull();
  });

  it("refuses a version that is no major.minor", () => {
    expect(() => contractVersionProblem("1.0.0", "1.0", "none")).toThrow('"1.0.0" is no plugin contract version like 1.0');
  });
});
