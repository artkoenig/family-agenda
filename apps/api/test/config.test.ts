import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://localhost/family_agenda" };

describe("the version in the configuration", () => {
  it("is the one the image was built with", () => {
    expect(readConfig({ ...base, APP_VERSION: "0.3.1" }).version).toBe("0.3.1");
  });

  it("is a development build when the image names none, or names it empty", () => {
    expect(readConfig(base).version).toBe("dev");
    expect(readConfig({ ...base, APP_VERSION: "" }).version).toBe("dev");
  });
});
