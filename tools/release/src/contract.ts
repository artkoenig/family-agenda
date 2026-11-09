export type ContractChange = "none" | "additive" | "breaking";

/**
 * Runs oasdiff's `breaking` or `changelog` on two OpenAPI documents, given as text, and says
 * whether it found anything: a breaking change, or any change at all.
 */
export type Oasdiff = (command: "breaking" | "changelog", base: string, revision: string) => boolean;

/** The document with its version set aside, so that raising the version alone is no change. */
function withoutVersion(document: string): string {
  const parsed = JSON.parse(document) as { info: { version: string } };
  return JSON.stringify({ ...parsed, info: { ...parsed.info, version: "0.0" } });
}

/** Whether `openapi.json` only grew since a release, or something was removed or changed. */
export function classifyContractChange(previous: string, current: string, oasdiff: Oasdiff): ContractChange {
  const [base, revision] = [withoutVersion(previous), withoutVersion(current)];
  if (oasdiff("breaking", base, revision)) return "breaking";
  return oasdiff("changelog", base, revision) ? "additive" : "none";
}

type Version = [major: number, minor: number];

function parseVersion(version: string): Version {
  const parts = /^(\d+)\.(\d+)$/.exec(version);
  if (parts === null) throw new Error(`"${version}" is no plugin contract version like 1.0`);
  return [Number(parts[1]), Number(parts[2])];
}

const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1];

/**
 * What is wrong with `contractVersion` after the contract changed since a release, or null: a
 * breaking change needs a new major, an addition a new minor, and the version never goes down.
 */
export function contractVersionProblem(previous: string, current: string, change: ContractChange): string | null {
  const [before, after] = [parseVersion(previous), parseVersion(current)];
  if (compare(after, before) < 0) return `The plugin contract version went down, from ${previous} to ${current}.`;
  if (change === "none") return null;
  const lowest: Version = change === "breaking" ? [before[0] + 1, 0] : [before[0], before[1] + 1];
  if (compare(after, lowest) >= 0) return null;
  const what = change === "breaking" ? "had something removed or changed" : "has grown";
  return `The plugin contract ${what} since the last release, but contractVersion is still ${current} (was ${previous}). Raise it to at least ${lowest.join(".")} in packages/plugin-contract/src/index.ts, and run \`pnpm openapi\`.`;
}
