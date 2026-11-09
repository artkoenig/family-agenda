import { parse, stringify } from "yaml";
import { composeOf, nameCollisionsOf, passwordVariablesOf } from "./compose";
import { pluginsFileSchema } from "./schema";

export type Generated = { ok: true; compose: string; dotEnv: string | null } | { ok: false; errors: string[] };

const header = "# Generated from plugins.yml by `plugins generate` (docs/configuration.md). Do not edit.\n";

/**
 * Validates `plugins.yml` and turns it into `compose.plugins.yaml`. `dotEnv` is the current `.env`,
 * null for none; the result's `dotEnv` adds a password for each new database, null if unchanged.
 */
export function generatePluginsCompose(pluginsYml: string, dotEnv: string | null, newPassword: () => string): Generated {
  let raw: unknown;
  try {
    raw = parse(pluginsYml) ?? {};
  } catch (error) {
    return { ok: false, errors: [`plugins.yml is not YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const result = pluginsFileSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((issue) => `${["plugins.yml", ...issue.path].join(".")}: ${issue.message}`) };
  }
  const collisions = nameCollisionsOf(result.data);
  if (collisions.length > 0) return { ok: false, errors: collisions };
  return {
    ok: true,
    compose: header + stringify(composeOf(result.data)),
    dotEnv: withPasswords(dotEnv ?? "", passwordVariablesOf(result.data), newPassword),
  };
}

function withPasswords(dotEnv: string, variables: string[], newPassword: () => string): string | null {
  const missing = variables.filter((variable) => !new RegExp(`^${variable}=`, "m").test(dotEnv));
  if (missing.length === 0) return null;
  const separator = dotEnv === "" || dotEnv.endsWith("\n") ? "" : "\n";
  return `${dotEnv}${separator}${missing.map((variable) => `${variable}=${newPassword()}\n`).join("")}`;
}
