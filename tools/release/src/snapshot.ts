import { execFileSync } from "node:child_process";
import type { Snapshot } from "./upgrading";

const migrationsFolder = "packages/adapters/drizzle";

/**
 * Runs git in `repo`, with no shell, so that nothing in a ref or a path is ever interpreted. It is
 * the git of the PATH, as in the CI job and on a developer's machine.
 */
function git(repo: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A file only releases with Source plugins in-process had: their SDK. It is gone from this tree,
 * but stays here to recognise those releases at the historical ref an upgrade starts from.
 */
const inProcessPluginsMarker = "packages/source-sdk/package.json";

/** A file as it is at a ref, or null where there is none. */
function readOptional(repo: string, ref: string, file: string): string | null {
  return git(repo, "ls-tree", "--name-only", ref, file).trim() === "" ? null : git(repo, "show", `${ref}:${file}`);
}

/** Whether the release at a ref ran Source plugins in-process, with the SDK. */
function hasInProcessPlugins(repo: string, ref: string): boolean {
  return readOptional(repo, ref, inProcessPluginsMarker) !== null;
}

/** The plugin contract's `openapi.json` at a ref; null where the ref has none yet. */
export function readContract(repo: string, ref: string): string | null {
  return readOptional(repo, ref, "packages/plugin-contract/openapi.json");
}

/** The migrations, the `compose.yaml` and how plugins run, as they are at a Git ref, such as a tag or `HEAD`. */
export function readSnapshot(repo: string, ref: string): Snapshot {
  const files = git(repo, "ls-tree", "--name-only", ref, `${migrationsFolder}/`)
    .split("\n")
    .filter((file) => file.endsWith(".sql"));
  return {
    migrations: Object.fromEntries(files.map((file) => [file.slice(migrationsFolder.length + 1), git(repo, "show", `${ref}:${file}`)])),
    compose: git(repo, "show", `${ref}:compose.yaml`),
    inProcessPlugins: hasInProcessPlugins(repo, ref),
  };
}
