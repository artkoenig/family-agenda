/**
 * `node --import tsx tools/release/src/main.ts --docs <address of docs/upgrading.md> [--previous <ref>] [--current <ref>]`
 * prints the "Upgrading" section of a GitHub Release. `--previous` is the tag of the release
 * before it and is left out for the first release; `--current` is what is released and defaults to HEAD.
 */
import { parseArgs } from "node:util";
import { readSnapshot } from "./snapshot";
import { deriveUpgrading } from "./upgrading";

const { values } = parseArgs({
  options: { previous: { type: "string" }, current: { type: "string", default: "HEAD" }, docs: { type: "string" } },
});
if (!values.docs) {
  console.error("Usage: main.ts --docs <address of docs/upgrading.md> [--previous <ref>] [--current <ref>]");
  process.exit(2);
}

const repo = process.cwd();
const previous = values.previous === undefined ? null : readSnapshot(repo, values.previous);
process.stdout.write(deriveUpgrading(previous, readSnapshot(repo, values.current), values.docs));
