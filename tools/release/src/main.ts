/**
 * Release tooling, run from the root of the repository with `node --import tsx tools/release/src/main.ts`:
 *
 *   upgrading --docs <address of docs/upgrading.md> [--previous <ref>] [--current <ref>]
 *       prints the "Upgrading" section of a GitHub Release. `--previous` is the tag of the release
 *       before it and is left out for the first release; `--current` defaults to HEAD.
 *   check-sdk [--previous <ref>] [--current <ref>]
 *       fails if the SDK's public API changed since `--previous` without its version being raised.
 *   sdk-api [--write]
 *       prints the SDK's public API, or writes it to packages/source-sdk/api.txt (`pnpm sdk-api`).
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { describeSdkApi, sdkVersionProblem } from "./sdk";
import { readSnapshot } from "./snapshot";
import { deriveUpgrading } from "./upgrading";

const sdkDirectory = "packages/source-sdk";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    previous: { type: "string" },
    current: { type: "string", default: "HEAD" },
    docs: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const repo = process.cwd();
// A workflow passes an empty --previous where there is no release yet.
const previousRef = values.previous || undefined;

function usage(): never {
  console.error("Usage: main.ts upgrading --docs <address> [--previous <ref>] [--current <ref>] | check-sdk [--previous <ref>] [--current <ref>] | sdk-api [--write]");
  process.exit(2);
}

function upgrading(): void {
  if (!values.docs) usage();
  const previous = previousRef === undefined ? null : readSnapshot(repo, previousRef);
  process.stdout.write(deriveUpgrading(previous, readSnapshot(repo, values.current), values.docs));
}

function checkSdk(): void {
  const before = previousRef === undefined ? null : readSnapshot(repo, previousRef).sdk;
  if (before === null) {
    console.log("There is no earlier release with an SDK API file to compare the SDK with.");
    return;
  }
  const current = readSnapshot(repo, values.current).sdk;
  if (current === null) throw new Error(`${values.current} has no ${sdkDirectory}/api.txt: run pnpm sdk-api`);
  const problem = sdkVersionProblem(before, current);
  if (problem !== null) {
    console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`The SDK is at ${current.version}, and its API agrees with the change since ${previousRef}.`);
}

function sdkApi(): void {
  const api = describeSdkApi(`${repo}/${sdkDirectory}`);
  if (values.write) writeFileSync(`${repo}/${sdkDirectory}/api.txt`, api);
  else process.stdout.write(api);
}

const commands: Record<string, () => void> = { upgrading, "check-sdk": checkSdk, "sdk-api": sdkApi };
(commands[positionals[0] ?? ""] ?? usage)();
