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

/** The migrations and the `compose.yaml` as they are at a Git ref, such as a tag or `HEAD`. */
export function readSnapshot(repo: string, ref: string): Snapshot {
  const files = git(repo, "ls-tree", "--name-only", ref, `${migrationsFolder}/`)
    .split("\n")
    .filter((file) => file.endsWith(".sql"));
  return {
    migrations: Object.fromEntries(files.map((file) => [file.slice(migrationsFolder.length + 1), git(repo, "show", `${ref}:${file}`)])),
    compose: git(repo, "show", `${ref}:compose.yaml`),
  };
}
