/** Writes `openapi.json` next to this package's `package.json` (`pnpm openapi`). */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeOpenApi } from "./openapi";

writeFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), `${JSON.stringify(describeOpenApi(), null, 2)}\n`);
