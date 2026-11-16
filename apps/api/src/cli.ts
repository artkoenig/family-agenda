import { text } from "node:stream/consumers";
import { sealContextCommand } from "./context/seal-command";

const usage = "Usage: family-agenda seal-context < context.json";

const [command] = process.argv.slice(2);
if (command !== "seal-context") {
  console.error(usage);
  process.exit(2);
}
// For the trusted caller in front of a core in supplied mode, and for trying one by hand (docs/configuration.md).
process.stdout.write(`${sealContextCommand(process.env.CONTEXT_KEY ?? "", await text(process.stdin), Date.now())}\n`);
