import { bootApplication } from "./composition-root";
import { text } from "node:stream/consumers";
import { readConfig } from "./config";
import { sealContextCommand } from "./context/seal-command";

const usage = "Usage: family-agenda enter-admin <email> | reset-admin-password <email> | seal-context < context.json";

const [command, email] = process.argv.slice(2);
if (command === "seal-context") {
  // For the trusted caller in front of a core in supplied mode, and for trying one by hand (docs/configuration.md).
  process.stdout.write(`${sealContextCommand(process.env.CONTEXT_KEY ?? "", await text(process.stdin), Date.now())}\n`);
  process.exit(0);
}
if ((command !== "enter-admin" && command !== "reset-admin-password") || !email) {
  console.error(usage);
  process.exit(2);
}

// The same calls as the Triggered operations `enter-admin` and `reset-admin-password`.
const application = await bootApplication(readConfig());
try {
  if (command === "enter-admin") {
    const result = await application.admins.enterAdmin({ email });
    if (!result.ok) {
      console.error(`${email} is not a valid email address.`);
      process.exitCode = 1;
    } else if (result.outcome !== "exists") {
      console.log(`Entered the ${result.outcome === "first" ? "first " : ""}Admin ${result.email}, without a password.`);
      console.log("Sign in through the Identity Provider with this verified email, or reset the password.");
    } else {
      console.log(`An Admin with the email ${result.email} exists already; nothing changed.`);
    }
  } else {
    const result = await application.admins.issueNewPassword({ email });
    if (!result.ok && result.problem === "invalid-email") {
      console.error(`${email} is not a valid email address.`);
      process.exitCode = 1;
    } else if (!result.ok) {
      console.error(`No Admin with the email ${email}.`);
      process.exitCode = 1;
    } else {
      console.log(`New password for ${result.email}: ${result.newPassword}`);
      console.log("The Admin's sessions have ended. Sign in with this password.");
    }
  }
} finally {
  await application.close();
}
