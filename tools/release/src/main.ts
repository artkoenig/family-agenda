/**
 * Release tooling, run from the root of the repository with `node --import tsx tools/release/src/main.ts`:
 *
 *   upgrading --docs <address of docs/upgrading.md> [--previous <ref>] [--current <ref>]
 *       prints the "Upgrading" section of a GitHub Release. `--previous` is the tag of the release
 *       before it and is left out for the first release; `--current` defaults to HEAD.
 *   check-sdk [--previous <ref>] [--current <ref>]
 *       fails if the public API of a package changed since `--previous` without its version being raised.
 *   sdk-api [--write]
 *       prints the public API of every package, or writes it to packages/<name>/api.txt (`pnpm sdk-api`).
 *   ghcr-plan --versions <versions.json> --children <children.json>
 *       prints the ids of the versions of the image package that the weekly clean-up deletes, one per line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { planCleanup, versionsFromApi, type Children } from "./cleanup";
import { readdirSync } from "node:fs";
import { describePackageApi, sdkVersionProblem } from "./sdk";
import { readPackageApis, readSnapshot } from "./snapshot";
import { deriveUpgrading } from "./upgrading";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    previous: { type: "string" },
    current: { type: "string", default: "HEAD" },
    docs: { type: "string" },
    write: { type: "boolean", default: false },
    versions: { type: "string" },
    children: { type: "string" },
  },
});
const repo = process.cwd();
// A workflow passes an empty --previous where there is no release yet.
const previousRef = values.previous || undefined;

function usage(): never {
  console.error("Usage: main.ts upgrading --docs <address> [--previous <ref>] [--current <ref>] | check-sdk [--previous <ref>] [--current <ref>] | sdk-api [--write] | ghcr-plan --versions <file> --children <file>");
  process.exit(2);
}

function upgrading(): void {
  if (!values.docs) usage();
  const previous = previousRef === undefined ? null : readSnapshot(repo, previousRef);
  process.stdout.write(deriveUpgrading(previous, readSnapshot(repo, values.current), values.docs));
}

function checkSdk(): void {
  if (previousRef === undefined) {
    console.log("There is no earlier release with API files to compare the packages with.");
    return;
  }
  const before = readPackageApis(repo, previousRef);
  const current = readPackageApis(repo, values.current);
  const problems: string[] = [];
  for (const folder of packageFolders()) {
    if (describePackageApi(`${repo}/packages/${folder}`) !== null && !(folder in current)) {
      problems.push(`${values.current} has no packages/${folder}/api.txt: run pnpm sdk-api`);
    }
  }
  for (const [folder, snapshot] of Object.entries(current)) {
    const earlier = before[folder];
    if (earlier === undefined) continue;
    const subject = folder === "source-sdk" ? undefined : { name: `the package ${folder}`, manifest: `packages/${folder}/package.json` };
    const problem = sdkVersionProblem(earlier, snapshot, subject);
    if (problem !== null) problems.push(problem);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`The API of ${Object.keys(current).length} packages agrees with their versions since ${previousRef}.`);
}

const packageFolders = () => readdirSync(`${repo}/packages`, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => entry.name);

function sdkApi(): void {
  for (const folder of packageFolders()) {
    const api = describePackageApi(`${repo}/packages/${folder}`);
    if (api === null) continue;
    if (values.write) writeFileSync(`${repo}/packages/${folder}/api.txt`, api);
    else process.stdout.write(`${api}\n`);
  }
}

/** What the weekly clean-up keeps: the newest 30 images tagged only with a commit, and untagged versions that are a day old. */
function ghcrPlan(): void {
  if (!values.versions || !values.children) usage();
  const versions = versionsFromApi(JSON.parse(readFileSync(values.versions, "utf8")) as Parameters<typeof versionsFromApi>[0]);
  const children = JSON.parse(readFileSync(values.children, "utf8")) as Children;
  const plan = planCleanup(versions, children, new Date(), { keepShaImages: 30, minimumAgeDays: 1, maximumDeletions: 100 });
  console.error(`${versions.length} versions: ${plan.keptTagged} tagged stay, ${plan.keptUntagged} untagged stay, ${plan.delete.length} go.`);
  for (const version of plan.delete) console.error(`  delete ${version.id} ${version.digest} ${version.tags.join(",") || "(untagged)"}`);
  process.stdout.write(plan.delete.map((version) => `${version.id}\n`).join(""));
}

const commands: Record<string, () => void> = { upgrading, "check-sdk": checkSdk, "sdk-api": sdkApi, "ghcr-plan": ghcrPlan };
(commands[positionals[0] ?? ""] ?? usage)();
