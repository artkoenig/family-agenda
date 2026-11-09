/** Writes `plugins.schema.json` at the repository root (`pnpm plugins-schema`). */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pluginsFileJsonSchema } from "./schema";

writeFileSync(fileURLToPath(new URL("../../../../plugins.schema.json", import.meta.url)), `${JSON.stringify(pluginsFileJsonSchema(), null, 2)}\n`);
