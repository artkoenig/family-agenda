import { describe, expect, it } from "vitest";
import { readConfig, readMode, readSuppliedConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://x" };
const oidc = {
  ...base,
  PUBLIC_URL: "https://agenda.example.ts.net",
  OIDC_ISSUER_URL: "https://id.example.ts.net",
  OIDC_CLIENT_ID: "family-agenda",
  OIDC_CLIENT_SECRET: "s3cret",
};

const suppliedOidc = { OIDC_ISSUER_URL: "https://id.example.ts.net", OIDC_CLIENT_ID: "family-agenda", OIDC_CLIENT_SECRET: "s3cret", OIDC_CALLBACK_URL: "https://sign-in.example.org/sso/callback/" };

describe("the Identity Provider's management API in the environment", () => {
  const management = {
    IDP_MANAGEMENT_API: "logto",
    IDP_MANAGEMENT_ENDPOINT: "https://id.example.org/",
    IDP_MANAGEMENT_CLIENT_ID: "m2m",
    IDP_MANAGEMENT_CLIENT_SECRET: "s3cret",
  };
  const supplied = { CONTEXT_MODE: "supplied", CONTEXT_KEY: "a-context-key-of-at-least-32-characters", CALLER_PORT: "3002", ...suppliedOidc };

  it("is off without any IDP_MANAGEMENT_* variable", () => {
    expect(readConfig(base).identityDirectory).toBeNull();
    expect(readSuppliedConfig(supplied).identityDirectory).toBeNull();
  });

  it("is read in either mode", () => {
    const settings = { api: "logto", endpoint: "https://id.example.org", clientId: "m2m", clientSecret: "s3cret" };
    expect(readConfig({ ...base, ...management }).identityDirectory).toEqual(settings);
    expect(readSuppliedConfig({ ...supplied, ...management }).identityDirectory).toEqual(settings);
  });

  it("stops the start naming the variable that is missing or wrong", () => {
    expect(() => readConfig({ ...base, ...management, IDP_MANAGEMENT_API: "keycloak" })).toThrow(/^IDP_MANAGEMENT_API must be logto/);
    expect(() => readConfig({ ...base, ...management, IDP_MANAGEMENT_ENDPOINT: undefined })).toThrow(/^IDP_MANAGEMENT_ENDPOINT must be/);
    expect(() => readConfig({ ...base, ...management, IDP_MANAGEMENT_CLIENT_ID: "" })).toThrow(/^IDP_MANAGEMENT_CLIENT_ID must be set/);
    expect(() => readConfig({ ...base, ...management, IDP_MANAGEMENT_CLIENT_SECRET: undefined })).toThrow(/^IDP_MANAGEMENT_CLIENT_SECRET must be set/);
  });
});

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
      groupsClaim: "groups",
      publicBaseUrl: "https://agenda.example.ts.net",
    });
    expect(readConfig({ ...oidc, OIDC_REQUIRED_GROUP: "parents" }).identityProvider?.requiredGroup).toBe("parents");
    expect(readConfig({ ...oidc, OIDC_REQUIRED_GROUP: "" }).identityProvider?.requiredGroup).toBe("homelab-admin");
  });

  it("reads the groups from OIDC_GROUPS_CLAIM, and refuses a value that is no claim name", () => {
    expect(readConfig({ ...oidc, OIDC_GROUPS_CLAIM: "roles" }).identityProvider?.groupsClaim).toBe("roles");
    expect(readConfig({ ...oidc, OIDC_GROUPS_CLAIM: "" }).identityProvider?.groupsClaim).toBe("groups");
    expect(() => readConfig({ ...oidc, OIDC_GROUPS_CLAIM: "groups roles" })).toThrow(/OIDC_GROUPS_CLAIM must be a claim name/);
  });

  it("serves every Family in supplied mode, required, with the Family claim family_id by default", () => {
    const supplied = { CONTEXT_MODE: "supplied", CONTEXT_KEY: "a-context-key-of-at-least-32-characters", CALLER_PORT: "3002", ...suppliedOidc };
    expect(readSuppliedConfig(supplied).identityProvider).toEqual({
      issuerUrl: "https://id.example.ts.net",
      clientId: "family-agenda",
      clientSecret: "s3cret",
      requiredGroup: "homelab-admin",
      groupsClaim: "groups",
      familyIdClaim: "family_id",
      callbackUrl: "https://sign-in.example.org/sso/callback",
    });
    expect(readSuppliedConfig({ ...supplied, OIDC_FAMILY_ID_CLAIM: "custom_data.familyId" }).identityProvider.familyIdClaim).toBe("custom_data.familyId");
    expect(() => readSuppliedConfig({ ...supplied, OIDC_FAMILY_ID_CLAIM: "custom_data..familyId" })).toThrow(/OIDC_FAMILY_ID_CLAIM must be a claim name or a dotted path/);
    expect(() => readSuppliedConfig({ ...supplied, OIDC_ISSUER_URL: undefined })).toThrow(/OIDC_ISSUER_URL must be set with CONTEXT_MODE=supplied/);
    expect(() => readSuppliedConfig({ ...supplied, OIDC_CLIENT_ID: undefined })).toThrow(/OIDC_CLIENT_ID must be set/);
    expect(() => readSuppliedConfig({ ...supplied, OIDC_CLIENT_SECRET: undefined })).toThrow(/OIDC_CLIENT_SECRET must be set/);
  });

  it("requires OIDC_CALLBACK_URL in supplied mode: an http or https address with a path, without query or fragment", () => {
    const supplied = { CONTEXT_MODE: "supplied", CONTEXT_KEY: "a-context-key-of-at-least-32-characters", CALLER_PORT: "3002", ...suppliedOidc };
    for (const value of [undefined, "", "sign-in.example.org/sso/callback", "ftp://sign-in.example.org/cb", "https://sign-in.example.org", "https://sign-in.example.org/cb?x=1", "https://sign-in.example.org/cb#x"]) {
      expect(() => readSuppliedConfig({ ...supplied, OIDC_CALLBACK_URL: value })).toThrow(/OIDC_CALLBACK_URL must be set with CONTEXT_MODE=supplied/);
    }
  });

  it("refuses OIDC_FAMILY_ID_CLAIM and OIDC_CALLBACK_URL in fixed mode, where the group decides and the callback lies below PUBLIC_URL", () => {
    expect(() => readConfig({ ...oidc, OIDC_FAMILY_ID_CLAIM: "family_id" })).toThrow(/OIDC_FAMILY_ID_CLAIM is set, but CONTEXT_MODE is not supplied/);
    expect(() => readConfig({ ...oidc, OIDC_CALLBACK_URL: "https://sign-in.example.org/sso/callback" })).toThrow(/OIDC_CALLBACK_URL is set, but CONTEXT_MODE is not supplied/);
  });

  it("refuses to start with OIDC_KNOWN_ADMINS_ONLY, which is no longer known", () => {
    expect(() => readConfig({ ...oidc, OIDC_KNOWN_ADMINS_ONLY: "true" })).toThrow(/OIDC_KNOWN_ADMINS_ONLY is not a known variable/);
    expect(() => readConfig({ ...oidc, OIDC_KNOWN_ADMINS_ONLY: "" })).toThrow(/OIDC_KNOWN_ADMINS_ONLY is not a known variable/);
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
      trigger: { port: 3001, token: null },
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
        TRIGGER_PORT: "4001",
        TRIGGER_TOKEN: "t0ken",
        TRUST_PROXY: "true",
        PUBLIC_URL: "https://agenda.example.org/x",
      }),
    ).toMatchObject({
      masterKeyFile: "/k",
      blobDirectory: "/b",
      tessdataDirectory: "/t",
      bundledTessdataDirectory: "/u",
      port: 8080,
      trigger: { port: 4001, token: "t0ken" },
      trustProxy: true,
      publicUrl: "https://agenda.example.org/x",
    });
  });
});

describe("the public address in the environment", () => {
  it("keeps its path, the path prefix, without a trailing slash", () => {
    expect(readConfig({ ...base, PUBLIC_URL: "https://home.example.org/agenda/" }).publicUrl).toBe("https://home.example.org/agenda");
    expect(readConfig({ ...base, PUBLIC_URL: "http://192.168.1.10:8080/" }).publicUrl).toBe("http://192.168.1.10:8080");
  });
});

describe("the ticket key in the environment", () => {
  const key = "abcdefghijklmnopqrstuvwxyz012345";
  const plugins = { ...base, PLUGIN_URLS: "imap=http://plugin-imap:8080" };

  it("is required with plugin containers", () => {
    expect(() => readConfig(plugins)).toThrow(/EGRESS_TICKET_KEY must be set/);
    expect(readConfig({ ...plugins, EGRESS_TICKET_KEY: key }).egressTicketKey).toBe(key);
  });

  it("may be left out without plugin containers", () => {
    expect(readConfig(base).egressTicketKey).toBeNull();
  });

  it("is refused when it is short", () => {
    expect(() => readConfig({ ...base, EGRESS_TICKET_KEY: key.slice(1) })).toThrow(/at least 32 characters/);
  });

  it("takes the Family id from FAMILY_ID, a UUID, and none when it is empty", () => {
    expect(readConfig({ ...base, FAMILY_ID: "0B6F3C1E-8A2D-4F5B-9C7E-1D2A3B4C5D6E" }).familyId).toBe("0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e");
    expect(readConfig({ ...base, FAMILY_ID: "" })).not.toHaveProperty("familyId");
    expect(() => readConfig({ ...base, FAMILY_ID: "family-1" })).toThrow(/FAMILY_ID must be a UUID/);
  });
});

describe("the mode of the core", () => {
  const contextKey = "a-context-key-of-at-least-32-characters";

  it("is fixed without CONTEXT_MODE, or with it set to fixed, and reads the Family from the environment", () => {
    expect(readMode(base)).toBe("fixed");
    expect(readMode({ ...base, CONTEXT_MODE: "fixed" })).toBe("fixed");
    expect(readConfig({ ...base, CONTEXT_MODE: "fixed" }).databaseUrl).toBe("postgres://x");
  });

  it("refuses to start in fixed mode with a Context key set, and in supplied mode without one", () => {
    expect(() => readMode({ ...base, CONTEXT_KEY: contextKey })).toThrow(/CONTEXT_KEY is set, but CONTEXT_MODE is not supplied/);
    expect(() => readConfig({ ...base, CONTEXT_KEY: contextKey })).toThrow(/CONTEXT_MODE/);
    expect(() => readMode({ CONTEXT_MODE: "supplied" })).toThrow(/CONTEXT_KEY must be set/);
    expect(() => readMode({ CONTEXT_MODE: "supplied", CONTEXT_KEY: "short" })).toThrow(/at least 32 characters/);
    expect(() => readMode({ CONTEXT_MODE: "both" })).toThrow(/CONTEXT_MODE must be fixed or supplied/);
  });

  it("reads no Family from the environment in supplied mode, and refuses one given there", () => {
    const supplied = { CONTEXT_MODE: "supplied", CONTEXT_KEY: contextKey, PORT: "8080", CALLER_PORT: "3002", TZ: "Europe/Berlin", ...suppliedOidc };
    expect(readMode(supplied)).toBe("supplied");
    expect(readSuppliedConfig(supplied)).toMatchObject({ contextKey, callerPort: 3002, trustProxy: false, pluginContainers: [] });
    expect(readSuppliedConfig(supplied)).not.toHaveProperty("publicUrl");
    expect(readSuppliedConfig(supplied)).not.toHaveProperty("databaseUrl");
    expect(readSuppliedConfig(supplied)).not.toHaveProperty("port");
    expect(() => readSuppliedConfig({ ...supplied, CALLER_PORT: undefined })).toThrow(/CALLER_PORT must be set/);
    expect(() => readSuppliedConfig({ ...supplied, CALLER_PORT: "http" })).toThrow(/CALLER_PORT must be set/);
    expect(() => readSuppliedConfig({ ...supplied, CALLER_PORT: "8080" })).toThrow(/CALLER_PORT must differ from PORT/);
    expect(() => readSuppliedConfig({ ...supplied, PUBLIC_URL: "https://x.example.org" })).toThrow(/PUBLIC_URL must not be set with CONTEXT_MODE=supplied: every Context/);
    for (const variable of ["OIDC_REQUIRED_GROUP", "OIDC_GROUPS_CLAIM"]) {
      expect(() => readSuppliedConfig({ ...supplied, [variable]: "roles" })).toThrow(new RegExp(`${variable} must not be set with CONTEXT_MODE=supplied: the claim OIDC_FAMILY_ID_CLAIM names decides`));
    }
    for (const variable of ["DATABASE_URL", "FAMILY_ID", "MASTER_KEY_FILE", "BLOB_DIRECTORY"]) {
      expect(() => readSuppliedConfig({ ...supplied, [variable]: "x" })).toThrow(new RegExp(`${variable} must not be set`));
    }
    expect(() => readConfig({ ...base, ...supplied })).toThrow(/supplied mode/);
    expect(() => readSuppliedConfig(base)).toThrow(/CONTEXT_MODE=supplied/);
  });
});
