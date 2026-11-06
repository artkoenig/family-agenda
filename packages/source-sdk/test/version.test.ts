import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sdkVersion } from "../src";

describe("the version of the SDK", () => {
  it("is the one of its package, which is where it is raised and where the release tooling reads it", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    expect(sdkVersion).toBe(version);
  });
});
