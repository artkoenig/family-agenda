/** Writes `plugins.schema.json` at the repository root (`pnpm plugins-schema`). */
import { writeFileSync } from "node:fs";
import { pluginsFileJsonSchema, pluginsSchemaFile } from "./schema";

writeFileSync(pluginsSchemaFile, `${JSON.stringify(pluginsFileJsonSchema(), null, 2)}\n`);
