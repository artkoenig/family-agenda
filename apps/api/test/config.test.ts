import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://x" };
const oidc = {
  ...base,
  PUBLIC_URL: "https://agenda.example.ts.net",
  OIDC_ISSUER_URL: "https://id.example.ts.net",
  OIDC_CLIENT_ID: "family-agenda",
  OIDC_CLIENT_SECRET: "s3cret",
};

describe("the Identity Provider in the environment", () => {
  it("is none without OIDC_ISSUER_URL", () => {
    expect(readConfig(base).identityProvider).toBeNull();
  });

  it("is read from the OIDC variables below PUBLIC_URL, with the default group", () => {
    expect(readConfig(oidc).identityProvider).toEqual({
      issuerUrl: "https://id.example.ts.net",
      clientId: "family-agenda",
      clientSecret: "s3cret",
      requiredGroup: "homelab-admin",
      publicBaseUrl: "https://agenda.example.ts.net",
    });
    expect(readConfig({ ...oidc, OIDC_REQUIRED_GROUP: "parents" }).identityProvider?.requiredGroup).toBe("parents");
    expect(readConfig({ ...oidc, OIDC_REQUIRED_GROUP: "" }).identityProvider?.requiredGroup).toBe("homelab-admin");
  });

  it("refuses to start with a variable missing, naming it", () => {
    expect(() => readConfig({ ...oidc, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL must be set/);
    expect(() => readConfig({ ...oidc, OIDC_CLIENT_SECRET: undefined })).toThrow(/OIDC_CLIENT_SECRET/);
  });
});

describe("the configuration", () => {
  it("needs DATABASE_URL", () => {
    expect(() => readConfig({})).toThrow(/DATABASE_URL/);
  });

  it("takes the defaults", () => {
    expect(readConfig({ ...base, BUNDLED_TESSDATA_DIRECTORY: "" })).toMatchObject({
      masterKeyFile: "/var/lib/family-agenda/master-key/master.key",
      blobDirectory: "/var/lib/family-agenda/blobs",
      tessdataDirectory: "/var/lib/family-agenda/tessdata",
      bundledTessdataDirectory: null,
      port: 3000,
      trustProxy: false,
      publicUrl: null,
    });
  });

  it("takes what is set", () => {
    expect(
      readConfig({
        ...base,
        MASTER_KEY_FILE: "/k",
        BLOB_DIRECTORY: "/b",
        TESSDATA_DIRECTORY: "/t",
        BUNDLED_TESSDATA_DIRECTORY: "/u",
        PORT: "8080",
        TRUST_PROXY: "true",
        PUBLIC_URL: "https://agenda.example.org/x",
      }),
    ).toMatchObject({
      masterKeyFile: "/k",
      blobDirectory: "/b",
      tessdataDirectory: "/t",
      bundledTessdataDirectory: "/u",
      port: 8080,
      trustProxy: true,
      publicUrl: "https://agenda.example.org",
    });
  });
});
