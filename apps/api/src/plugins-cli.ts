import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePluginsCompose } from "./plugins-file/generate";
import { versionOf } from "./version";

const directory = process.env.DEPLOYMENT_DIRECTORY ?? "/deployment";

if (process.argv[2] !== "generate") {
  console.error("Usage: plugins generate");
  process.exit(2);
}

const read = (file: string) => (existsSync(join(directory, file)) ? readFileSync(join(directory, file), "utf8") : null);
const pluginsYml = read("plugins.yml");
if (pluginsYml === null) {
  console.error(`No plugins.yml in ${directory}, where to mount the directory of compose.yaml: docker compose run --rm -v "$PWD:/deployment" api plugins generate`);
  process.exit(1);
}
const generated = generatePluginsCompose(pluginsYml, read(".env"), () => randomBytes(24).toString("base64url"), versionOf(process.env));
if (!generated.ok) {
  for (const error of generated.errors) console.error(error);
  process.exit(1);
}
writeFileSync(join(directory, "compose.plugins.yaml"), generated.compose);
if (generated.dotEnv !== null) writeFileSync(join(directory, ".env"), generated.dotEnv);
console.log("Wrote compose.plugins.yaml. Activate it with COMPOSE_FILE=compose.yaml:compose.plugins.yaml in .env.");
