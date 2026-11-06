import { execFileSync } from "node:child_process";
import type { SdkSnapshot } from "./sdk";
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

const sdkFolder = "packages/source-sdk";

/** A file as it is at a ref, or null where there is none. */
function readOptional(repo: string, ref: string, file: string): string | null {
  return git(repo, "ls-tree", "--name-only", ref, file).trim() === "" ? null : git(repo, "show", `${ref}:${file}`);
}

/** The version of the SDK and its API file at a ref; null where the ref has no SDK package or no API file yet. */
function readSdk(repo: string, ref: string): SdkSnapshot | null {
  const manifest = readOptional(repo, ref, `${sdkFolder}/package.json`);
  const api = readOptional(repo, ref, `${sdkFolder}/api.txt`);
  return manifest === null || api === null ? null : { version: (JSON.parse(manifest) as { version: string }).version, api };
}

/** The migrations, the `compose.yaml` and the SDK as they are at a Git ref, such as a tag or `HEAD`. */
export function readSnapshot(repo: string, ref: string): Snapshot {
  const files = git(repo, "ls-tree", "--name-only", ref, `${migrationsFolder}/`)
    .split("\n")
    .filter((file) => file.endsWith(".sql"));
  return {
    migrations: Object.fromEntries(files.map((file) => [file.slice(migrationsFolder.length + 1), git(repo, "show", `${ref}:${file}`)])),
    compose: git(repo, "show", `${ref}:compose.yaml`),
    sdk: readSdk(repo, ref),
  };
}
