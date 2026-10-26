import { describe, expect, it } from "vitest";
import { problemsWith, sdkVersion, type SourcePlugin } from "../src";
import { describeSourcePluginContract } from "../src/testing";

const examplePlugin = (identity: Partial<SourcePlugin["identity"]> = {}): SourcePlugin => ({
  identity: {
    sourceTypeId: "example",
    displayName: "Example",
    version: "1.0.0",
    sdkVersion,
    ...identity,
  },
});

describeSourcePluginContract(() => examplePlugin());

describe("a plugin that is not loadable", () => {
  it("says why", () => {
    expect(
      problemsWith(examplePlugin({ sourceTypeId: "Example Type", sdkVersion: "9.0.0" })),
    ).toEqual([
      'Source Type id "Example Type" is not lowercase kebab-case',
      `built for SDK 9.0.0, but this is SDK ${sdkVersion}`,
    ]);
  });
});
