import { randomBytes } from "node:crypto";
import { bootApplication } from "./composition-root";
import { readConfig } from "./config";

const usage = "Usage: family-butler reset-admin-password <email>";

const [command, email] = process.argv.slice(2);
if (command !== "reset-admin-password" || !email) {
  console.error(usage);
  process.exit(2);
}

const application = await bootApplication({ databaseUrl: readConfig().databaseUrl });
try {
  const newPassword = randomBytes(12).toString("base64url");
  const result = await application.admins.resetPasswordByEmail({ email, newPassword });
  if (!result.ok) {
    console.error(`No Admin with the email ${email}.`);
    process.exitCode = 1;
  } else {
    console.log(`New password for ${email}: ${newPassword}`);
    console.log("The Admin's sessions have ended. Sign in with this password.");
  }
} finally {
  await application.close();
}
