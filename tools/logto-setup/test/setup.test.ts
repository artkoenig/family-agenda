import { describe, expect, it } from "vitest";
import { setUpLogto, smtpConfig, type SetupInput } from "../src/setup";
import { fakeManagementApi } from "./fake-management-api";

const input: SetupInput = {
  publicEndpoint: "https://sign-in.example.org/",
  redirectUris: ["https://agenda.example.org/sso/callback"],
  adminRole: "homelab-admin",
  firstAdmin: { username: "parent", email: "parent@example.org" },
  branding: { logoUrl: "data:image/svg+xml;base64,PHN2Zy8+", primaryColor: "#bb4f29", darkPrimaryColor: "#e8875f", customCss: "body {}" },
  suppliedMode: false,
};
const smtp = { host: "mail.example.org", port: 587, user: "agenda", password: "mail-password", fromEmail: "agenda@example.org" };
let passwords = 0;
const newPassword = () => `one-time-${String(++passwords)}`;
/** `setup` without a first Admin, as when registration creates them. */
const noFirstAdmin = (setup: SetupInput): SetupInput => {
  const copy = { ...setup };
  delete copy.firstAdmin;
  return copy;
};

describe("setting up Logto", () => {
  it("creates the client, the role and the first Admin with that role, and prints the OIDC values", async () => {
    const logto = fakeManagementApi();

    const result = await setUpLogto(logto.api, input, newPassword);

    const [client] = logto.tables.applications ?? [];
    expect(client).toMatchObject({ name: "Family Agenda", type: "Traditional", oidcClientMetadata: { redirectUris: input.redirectUris } });
    const [role] = logto.tables.roles ?? [];
    expect(role).toMatchObject({ name: "homelab-admin", type: "User" });
    const [user] = logto.tables.users ?? [];
    expect(user).toMatchObject({ username: "parent", primaryEmail: "parent@example.org", password: result.firstAdminPassword });
    expect(logto.userRoles[user?.id ?? ""]).toEqual([role?.id]);
    expect(result.oidc).toEqual({
      OIDC_ISSUER_URL: "https://sign-in.example.org/oidc",
      OIDC_CLIENT_ID: client?.id,
      OIDC_CLIENT_SECRET: `secret-of-${client?.id ?? ""}`,
      OIDC_REQUIRED_GROUP: "homelab-admin",
      OIDC_GROUPS_CLAIM: "roles",
    });
  });

  it("turns self-registration off, applies the branding and puts roles and custom data in the ID token", async () => {
    const logto = fakeManagementApi();

    await setUpLogto(logto.api, input, newPassword);

    expect(logto.signInExperience()).toEqual({
      signInMode: "SignIn",
      branding: { logoUrl: input.branding.logoUrl },
      color: { primaryColor: "#bb4f29", darkPrimaryColor: "#e8875f", isDarkModeEnabled: true },
      customCss: "body {}",
      forgotPasswordMethods: [],
    });
    expect(logto.idTokenConfig()).toEqual({ enabledExtendedClaims: ["roles", "custom_data", "organizations"] });
  });

  it("can run again without creating anything twice, keeping the first Admin's password", async () => {
    const logto = fakeManagementApi();
    const first = await setUpLogto(logto.api, input, newPassword);
    const created = logto.writes.filter((write) => write.startsWith("POST")).length;

    const second = await setUpLogto(logto.api, { ...input, smtp }, newPassword);
    const third = await setUpLogto(logto.api, { ...input, smtp }, newPassword);

    expect(logto.writes.filter((write) => write.startsWith("POST"))).toHaveLength(created + 1); // the SMTP connector, once
    expect(logto.tables.applications).toHaveLength(1);
    expect(logto.tables.roles).toHaveLength(1);
    expect(logto.tables.users).toHaveLength(1);
    expect(logto.tables.connectors).toHaveLength(1);
    expect(second.firstAdminPassword).toBeUndefined();
    expect(third.oidc).toEqual(first.oidc);
  });

  it("keeps the client's redirect URIs in step with the environment", async () => {
    const logto = fakeManagementApi();
    await setUpLogto(logto.api, input, newPassword);

    await setUpLogto(logto.api, { ...input, redirectUris: ["https://new.example.org/sso/callback"] }, newPassword);

    expect(logto.tables.applications?.[0]).toMatchObject({ oidcClientMetadata: { redirectUris: ["https://new.example.org/sso/callback"] } });
  });

  it("gives the client a secret when it has none", async () => {
    const logto = fakeManagementApi();
    await setUpLogto(logto.api, input, newPassword);
    logto.tables.secrets?.splice(0);

    const result = await setUpLogto(logto.api, input, newPassword);

    expect(result.oidc.OIDC_CLIENT_SECRET).toBe(`secret-of-${logto.tables.applications?.[0]?.id ?? ""}`);
    expect(logto.tables.secrets).toHaveLength(1);
  });

  it("configures the SMTP connector only with SMTP settings, and then offers a reset by email code", async () => {
    const without = fakeManagementApi();
    const withSmtp = fakeManagementApi();

    const plain = await setUpLogto(without.api, input, newPassword);
    const mailing = await setUpLogto(withSmtp.api, { ...input, smtp }, newPassword);

    expect(plain.smtpConfigured).toBe(false);
    expect(without.tables.connectors).toEqual([]);
    expect(mailing.smtpConfigured).toBe(true);
    expect(withSmtp.tables.connectors?.[0]).toMatchObject({ connectorId: "simple-mail-transfer-protocol", config: smtpConfig(smtp) });
    expect(withSmtp.signInExperience()).toMatchObject({ forgotPasswordMethods: ["EmailVerificationCode"] });
  });

  it("updates an existing SMTP connector with changed settings", async () => {
    const logto = fakeManagementApi();
    await setUpLogto(logto.api, { ...input, smtp }, newPassword);

    await setUpLogto(logto.api, { ...input, smtp: { ...smtp, host: "smtp.other.example" } }, newPassword);

    expect(logto.tables.connectors).toHaveLength(1);
    expect(logto.tables.connectors?.[0]).toMatchObject({ config: { host: "smtp.other.example" } });
  });

  it("prints the Family claim instead of the role in supplied mode", async () => {
    const result = await setUpLogto(fakeManagementApi().api, { ...input, suppliedMode: true }, newPassword);

    expect(result.oidc).toMatchObject({ OIDC_FAMILY_ID_CLAIM: "custom_data.familyId" });
    expect(result.oidc).not.toHaveProperty("OIDC_GROUPS_CLAIM");
    expect(result.oidc).not.toHaveProperty("OIDC_REQUIRED_GROUP");
  });
});

describe("opening registration (ADR-0010)", () => {
  const registration = {
    eventsUrl: "https://agenda.example.org/idp/events",
    management: { endpoint: "https://sign-in.example.org", clientId: "core", clientSecret: "core-secret" },
  };
  const registering: SetupInput = { ...input, smtp, registration };
  const withoutFirstAdmin = noFirstAdmin(registering);

  it("opens sign-up by email with a required verification, and creates no first Admin", async () => {
    const logto = fakeManagementApi();

    const result = await setUpLogto(logto.api, withoutFirstAdmin, newPassword);

    expect(result.registration).toBe("open");
    expect(logto.signInExperience()).toMatchObject({
      signInMode: "SignInAndRegister",
      signUp: { identifiers: ["email"], password: true, verify: true },
      signIn: { methods: [expect.objectContaining({ identifier: "email", password: true }), expect.objectContaining({ identifier: "username", password: true })] },
    });
    expect(logto.tables.users).toEqual([]);
    expect(result.firstAdminPassword).toBeUndefined();
  });

  it("registers the PostRegister webhook to the core, makes the organization role admin, and prints the IDP values", async () => {
    const logto = fakeManagementApi();

    const result = await setUpLogto(logto.api, registering, newPassword);

    const [hook] = logto.tables.hooks ?? [];
    expect(hook).toMatchObject({ name: "Family Agenda", events: ["PostRegister"], config: { url: registration.eventsUrl } });
    expect(logto.tables["organization-roles"]).toEqual([expect.objectContaining({ name: "admin" })]);
    expect(result.idp).toEqual({
      IDP_MANAGEMENT_API: "logto",
      IDP_MANAGEMENT_ENDPOINT: "https://sign-in.example.org",
      IDP_MANAGEMENT_CLIENT_ID: "core",
      IDP_MANAGEMENT_CLIENT_SECRET: "core-secret",
      IDP_WEBHOOK_SECRET: `signing-key-of-${hook?.id ?? ""}`,
    });
  });

  it("can run again without a second webhook or role, keeping the webhook's key and following a new address", async () => {
    const logto = fakeManagementApi();
    const first = await setUpLogto(logto.api, registering, newPassword);

    const second = await setUpLogto(logto.api, { ...registering, registration: { ...registration, eventsUrl: "https://new.example.org/idp/events" } }, newPassword);

    expect(logto.tables.hooks).toHaveLength(1);
    expect(logto.tables.hooks?.[0]).toMatchObject({ config: { url: "https://new.example.org/idp/events" } });
    expect(logto.tables["organization-roles"]).toHaveLength(1);
    expect(second.idp).toEqual(first.idp);
  });

  it("keeps registration closed in fixed mode once a Family exists, but not in supplied mode", async () => {
    const logto = fakeManagementApi();
    logto.tables.organizations?.push({ id: "org-1", name: "Family", customData: { familyId: "family-1" } });
    const supplied = fakeManagementApi();
    supplied.tables.organizations?.push({ id: "org-1", name: "Family" });

    const result = await setUpLogto(logto.api, registering, newPassword);
    const cloud = await setUpLogto(supplied.api, { ...registering, suppliedMode: true }, newPassword);

    expect(result.registration).toBe("family-exists");
    expect(logto.signInExperience()).toMatchObject({ signInMode: "SignIn" });
    expect(result.idp).toHaveProperty("IDP_WEBHOOK_SECRET");
    expect(cloud.registration).toBe("open");
  });

  it("keeps ADR-0009's setup without SMTP, as Logto cannot verify an email then", async () => {
    const logto = fakeManagementApi();

    const result = await setUpLogto(logto.api, { ...input, registration }, newPassword);

    expect(result.registration).toBe("needs-smtp");
    expect(result.idp).toBeUndefined();
    expect(logto.signInExperience()).toMatchObject({ signInMode: "SignIn" });
    expect(logto.signInExperience()).not.toHaveProperty("signUp");
    expect(logto.tables.hooks).toEqual([]);
    expect(logto.tables.users).toHaveLength(1);
  });

  it("is off without a management API", async () => {
    expect((await setUpLogto(fakeManagementApi().api, { ...input, smtp }, newPassword)).registration).toBe("off");
  });

  it("refuses to run without a first Admin when registration stays closed", async () => {
    await expect(setUpLogto(fakeManagementApi().api, noFirstAdmin(input), newPassword)).rejects.toThrow("FIRST_ADMIN_USERNAME");
  });
});

describe("the SMTP connector's settings", () => {
  it("has a template for every email Logto sends, and logs in only with a user", () => {
    const config = smtpConfig(smtp);
    const anonymous = smtpConfig({ host: "relay.lan", port: 465, fromEmail: "agenda@example.org" });

    const templates = config.templates as { usageType: string; content: string }[];
    expect(templates.map((t) => t.usageType)).toEqual(["ForgotPassword", "SignIn", "Register", "Generic", "OrganizationInvitation"]);
    // Codes in every one but the invitation, which carries the link with a one-time token (ADR-0011).
    expect(templates.slice(0, 4).every((t) => t.content.includes("{{code}}"))).toBe(true);
    expect(templates[4]?.content).toContain("{{link}}");
    expect(templates[4]?.content).not.toContain("{{code}}");
    expect(config).toMatchObject({ host: "mail.example.org", port: 587, secure: false, auth: { type: "login", user: "agenda", pass: "mail-password" } });
    expect(anonymous).toMatchObject({ secure: true, auth: { type: "login" } });
    expect(anonymous.auth).not.toHaveProperty("user");
  });

  it("logs in with an empty password when only a user is given", () => {
    expect(smtpConfig({ host: smtp.host, port: smtp.port, user: smtp.user, fromEmail: smtp.fromEmail })).toMatchObject({ auth: { user: "agenda", pass: "" } });
  });
});
