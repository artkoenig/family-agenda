import { withoutTrailingSlash, type ManagementApi } from "./management-api";

/** What the setup makes Logto hold, read from the environment by `readSetupEnvironment`. */
export interface SetupInput {
  /** The address browsers and the core reach Logto at; the issuer is `<endpoint>/oidc`. */
  publicEndpoint: string;
  redirectUris: string[];
  adminRole: string;
  firstAdmin: { username: string; email: string };
  branding: { logoUrl: string; primaryColor: string; darkPrimaryColor: string; customCss: string };
  smtp?: SmtpSettings;
  /** Supplied mode: the Family id comes from `custom_data.familyId`, no role is printed. */
  suppliedMode: boolean;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  password?: string;
  fromEmail: string;
}

export interface SetupResult {
  oidc: Record<string, string>;
  /** Set only on the run that created the first Admin. */
  firstAdminPassword?: string;
  smtpConfigured: boolean;
}

export const clientName = "Family Agenda";
export const smtpConnectorFactory = "simple-mail-transfer-protocol";

interface Named { id: string; name: string }
interface Application extends Named { type: string }
interface Connector { id: string; connectorId: string }
interface User { id: string; username: string | null }
interface Secret { value: string }

/**
 * Brings Logto to the state Family Agenda needs. Every step looks first and changes only what is
 * missing or differs, so it can run any number of times without creating anything twice.
 */
export async function setUpLogto(api: ManagementApi, input: SetupInput, newPassword: () => string): Promise<SetupResult> {
  const application = await ensureApplication(api, input.redirectUris);
  const roleId = await ensureRole(api, input.adminRole);
  if (input.smtp) await ensureSmtpConnector(api, input.smtp);
  await applySignInExperience(api, input);
  // Logto puts roles and custom data in the ID token only when they are enabled as extended
  // claims, besides the scopes `roles` and `custom_data` the core asks for.
  await api.put("/api/configs/id-token", { enabledExtendedClaims: ["roles", "custom_data"] });
  const firstAdminPassword = await ensureFirstAdmin(api, input.firstAdmin, roleId, newPassword);
  const secret = await applicationSecret(api, application.id);
  const oidc = oidcValues(input, application.id, secret);
  const smtpConfigured = input.smtp !== undefined;
  return firstAdminPassword === undefined ? { oidc, smtpConfigured } : { oidc, firstAdminPassword, smtpConfigured };
}

async function ensureApplication(api: ManagementApi, redirectUris: string[]): Promise<Application> {
  const oidcClientMetadata = { redirectUris, postLogoutRedirectUris: [] };
  const existing = ((await api.get("/api/applications?page_size=100")) as Application[]).find((app) => app.name === clientName && app.type === "Traditional");
  if (existing) {
    await api.patch(`/api/applications/${existing.id}`, { oidcClientMetadata });
    return existing;
  }
  return (await api.post("/api/applications", { name: clientName, type: "Traditional", oidcClientMetadata })) as Application;
}

async function ensureRole(api: ManagementApi, name: string): Promise<string> {
  const existing = ((await api.get("/api/roles?type=User&page_size=100")) as Named[]).find((role) => role.name === name);
  if (existing) return existing.id;
  const created = (await api.post("/api/roles", { name, description: "Admins of Family Agenda", type: "User" })) as Named;
  return created.id;
}

async function applySignInExperience(api: ManagementApi, input: SetupInput): Promise<void> {
  const { logoUrl, primaryColor, darkPrimaryColor, customCss } = input.branding;
  await api.patch("/api/sign-in-exp", {
    signInMode: "SignIn",
    branding: { logoUrl },
    color: { primaryColor, darkPrimaryColor, isDarkModeEnabled: true },
    customCss,
    // Without SMTP, a forgotten password is reset by someone in the Logto console.
    forgotPasswordMethods: input.smtp ? ["EmailVerificationCode"] : [],
  });
}

async function ensureSmtpConnector(api: ManagementApi, smtp: SmtpSettings): Promise<void> {
  const config = smtpConfig(smtp);
  const existing = ((await api.get("/api/connectors")) as Connector[]).find((connector) => connector.connectorId === smtpConnectorFactory);
  if (existing) await api.patch(`/api/connectors/${existing.id}`, { config });
  else await api.post("/api/connectors", { connectorId: smtpConnectorFactory, config });
}

/** The SMTP connector's settings, with a code template for each email Logto sends. */
export function smtpConfig(smtp: SmtpSettings): Record<string, unknown> {
  const template = (usageType: string, subject: string) => ({
    usageType,
    contentType: "text/plain",
    subject,
    content: `Your Family Agenda code is {{code}}. It expires in 10 minutes.`,
  });
  return {
    host: smtp.host,
    port: smtp.port,
    // Port 465 speaks TLS from the start; others upgrade with STARTTLS.
    secure: smtp.port === 465,
    // Logto requires `auth`; without a user, no SMTP login is attempted.
    auth: smtp.user ? { type: "login", user: smtp.user, pass: smtp.password ?? "" } : { type: "login" },
    fromEmail: smtp.fromEmail,
    templates: [
      template("ForgotPassword", "Reset your Family Agenda password"),
      template("SignIn", "Your Family Agenda sign-in code"),
      template("Register", "Your Family Agenda code"),
      template("Generic", "Your Family Agenda code"),
    ],
  };
}

async function ensureFirstAdmin(api: ManagementApi, admin: SetupInput["firstAdmin"], roleId: string, newPassword: () => string): Promise<string | undefined> {
  const found = (await api.get(`/api/users?search.username=${encodeURIComponent(admin.username)}&mode.username=exact`)) as User[];
  if (found.some((user) => user.username === admin.username)) return undefined;
  const password = newPassword();
  const user = (await api.post("/api/users", { username: admin.username, primaryEmail: admin.email, password })) as User;
  await api.post(`/api/users/${user.id}/roles`, { roleIds: [roleId] });
  return password;
}

async function applicationSecret(api: ManagementApi, applicationId: string): Promise<string> {
  const secrets = (await api.get(`/api/applications/${applicationId}/secrets`)) as Secret[];
  const first = secrets[0];
  if (first) return first.value;
  return ((await api.post(`/api/applications/${applicationId}/secrets`, { name: "family-agenda" })) as Secret).value;
}

function oidcValues(input: SetupInput, clientId: string, clientSecret: string): Record<string, string> {
  const common = { OIDC_ISSUER_URL: `${withoutTrailingSlash(input.publicEndpoint)}/oidc`, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret };
  return input.suppliedMode
    ? { ...common, OIDC_FAMILY_ID_CLAIM: "custom_data.familyId" }
    : { ...common, OIDC_REQUIRED_GROUP: input.adminRole, OIDC_GROUPS_CLAIM: "roles" };
}
