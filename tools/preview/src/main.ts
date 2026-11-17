/**
 * `pnpm preview up <pr>|main | down <pr>|main | list`: runs a pull request's code, or main's, as a throwaway Instance
 * with demo data, to try a change by hand before it is merged. The plan is in plan.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describePreviews, planPreview, type Command } from "./plan";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const usage = "Usage: pnpm preview up <pull-request>|main | down <pull-request>|main | list";

function run({ file, args, env }: Command): number {
  console.log(`\n$ ${[file, ...args].join(" ")}`);
  return spawnSync(file, args, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1;
}

function pullRequestOf(value: string | undefined) {
  // The generator writes into the worktree as the developer, not as the image's user.
  // Previews need Docker on Linux or macOS, where these exist.
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  return planPreview(value === "main" ? "main" : Number(value), repoRoot, user);
}

function up(value: string | undefined): number {
  const plan = pullRequestOf(value);
  if (existsSync(plan.worktree)) {
    console.error(`A preview of this pull request exists already. Remove it first: pnpm preview down ${value}`);
    return 1;
  }
  for (const command of plan.up) {
    const status = run(command);
    if (status !== 0) {
      console.error(`\nFailed. Clean up with: pnpm preview down ${value}`);
      return status;
    }
  }
  console.log(`\nPreview of ${value === "main" ? "main" : `pull request ${value}`} is running at ${plan.url}`);
  console.log(`Admin area: ${plan.url}/admin: sign in with any name on the mock Identity Provider's page, no password`);
  console.log(`Remove it with: pnpm preview down ${value}`);
  return 0;
}

/** Every step runs even if one fails, so a half-made preview can still be removed. */
function down(value: string | undefined): number {
  const failed = pullRequestOf(value).down.filter((command) => run(command) !== 0);
  if (failed.length > 0) console.warn("\nSome steps failed, which is fine for parts that were never made.");
  return 0;
}

function list(): number {
  // A developer tool: it runs the docker of the developer's own PATH, as `run` does for every step.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const listing = spawnSync("docker", ["compose", "ls", "--all", "--format", "json"], { encoding: "utf8" });
  if (listing.status !== 0) {
    console.error(listing.stderr);
    return 1;
  }
  const previews = describePreviews(listing.stdout);
  console.log(previews.length > 0 ? previews.join("\n") : "No previews.");
  return 0;
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "up") process.exitCode = up(argument);
  else if (command === "down") process.exitCode = down(argument);
  else if (command === "list") process.exitCode = list();
  else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
