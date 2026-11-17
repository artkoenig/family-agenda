/**
 * Sets up the optional Logto container (`docker compose --profile idp up`) for Family Agenda, and
 * can be run again at any time. Inside the stack: `docker compose run --rm -e ... api logto-setup`;
 * from a checkout: `pnpm logto-setup`. Settings come from the environment, see docs/configuration.md.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readSetupEnvironment } from "./input";
import { connectManagementApi } from "./management-api";
import { setUpLogto, type RegistrationOutcome } from "./setup";

const deployFile = (name: string) => readFileSync(new URL(`../../../deploy/idp/${name}`, import.meta.url));
const files = {
  customCss: deployFile("logto-sign-in.css").toString("utf8"),
  logoDataUrl: `data:image/svg+xml;base64,${deployFile("logo.svg").toString("base64")}`,
};
const registrationMessages: Record<RegistrationOutcome, string> = {
  open: "Registration open: sign-up by email, verified by a code; the PostRegister webhook reaches the core.",
  "family-exists": "The Family exists already, so registration stays closed; the webhook stays registered.",
  "needs-smtp": "IDP_MANAGEMENT_API is set, but there is no SMTP_HOST: Logto cannot verify an email without it, so registration stays off (ADR-0009 setup).",
  off: "No IDP_MANAGEMENT_API: registration stays off (ADR-0009 setup).",
};
try {
  const { apiEndpoint, appId, appSecret, input } = readSetupEnvironment(process.env, files);
  const api = await connectManagementApi(apiEndpoint, appId, appSecret);
  const result = await setUpLogto(api, input, () => randomBytes(18).toString("base64url"));
  console.log(result.smtpConfigured ? "SMTP connector configured: password reset by email code." : "No SMTP_HOST: a forgotten password is reset in the Logto console.");
  console.log(registrationMessages[result.registration]);
  if (result.firstAdminPassword) console.log(`Created ${input.firstAdmin?.username ?? ""} with the password ${result.firstAdminPassword} (shown only now).`);
  else if (!result.idp) console.log(`${input.firstAdmin?.username ?? ""} exists already; left unchanged.`);
  console.log("\nSet these for Family Agenda (.env) and restart it:\n");
  for (const [name, value] of Object.entries({ ...result.oidc, ...result.idp })) console.log(`${name}=${value}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
