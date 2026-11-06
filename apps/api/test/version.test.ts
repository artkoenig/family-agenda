import { describe, expect, it } from "vitest";
import { versionOf } from "../src/version";

describe("the version an image was built with", () => {
  it("is the one the build named", () => {
    expect(versionOf({ APP_VERSION: "0.3.1" })).toBe("0.3.1");
  });

  it("is a development build when the build named none, or named it empty", () => {
    expect(versionOf({})).toBe("dev");
    expect(versionOf({ APP_VERSION: "" })).toBe("dev");
  });
});
