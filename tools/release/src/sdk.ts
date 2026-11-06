import ts from "typescript";

/** The version of the SDK, and its public API as `describeSdkApi` writes it. */
export type SdkSnapshot = { version: string; api: string };

/** The files whose exports are the SDK's API: what a plugin imports. */
const entries = ["src/index.ts", "src/testing.ts"];

/** The version is part of the API file only through this line, which must not count as a change of the API. */
const versionLine = /^export declare const sdkVersion = /;

const header = "// The public API of @family-agenda/source-sdk, written by `pnpm sdk-api`. Do not edit it by hand.";

/**
 * The public API of the SDK as declarations, one member per line: what `tsc` would emit as `.d.ts`
 * for its entry points, without comments or the implementation. A line that is gone or different
 * is a change a plugin can break on; a line added is an addition.
 */
export function describeSdkApi(sdkDirectory: string): string {
  const files = entries.map((entry) => `${sdkDirectory}/${entry}`);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
    skipLibCheck: true,
    types: ["node"],
    newLine: ts.NewLineKind.LineFeed,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
  });
  const problems = ts.getPreEmitDiagnostics(program);
  if (problems.length > 0) {
    throw new Error(`The SDK does not compile: ${ts.flattenDiagnosticMessageText(problems[0]?.messageText, "\n")}`);
  }
  const declarations = new Map<string, string>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`No ${file}`);
    program.emit(source, (name, text) => declarations.set(name, text), undefined, true);
  }
  const sections = files.map((file, index) => {
    const text = declarations.get(file.replace(/\.ts$/, ".d.ts")) ?? "";
    const lines = text.split("\n").filter((line) => !versionLine.test(line));
    return [`// ${entries[index]}`, ...lines].join("\n").trimEnd();
  });
  return [header, ...sections].join("\n") + "\n";
}

export type ApiChange = "none" | "additive" | "breaking";

const countLines = (api: string) => {
  const counts = new Map<string, number>();
  for (const line of api.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

/**
 * Whether the API only grew, or something was removed or changed. A changed declaration counts as
 * a removed and an added line, so it is breaking, even when it would have been compatible: that is
 * the safe side, and a member added on a line of its own stays additive.
 */
export function classifyApiChange(previous: string, current: string): ApiChange {
  const before = countLines(previous);
  const after = countLines(current);
  const lost = [...before].some(([line, count]) => (after.get(line) ?? 0) < count);
  if (lost) return "breaking";
  return [...after].some(([line, count]) => (before.get(line) ?? 0) < count) ? "additive" : "none";
}

type Version = [major: number, minor: number, patch: number];

function parseVersion(version: string): Version {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (parts === null) throw new Error(`"${version}" is no version like 1.2.3`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a plugin built for SDK `builtFor` runs on SDK `running`: the same major, and no newer
 * minor; while the major is 0, the same minor. The SDK decides this itself when it loads a plugin;
 * this is the same rule, to tell Admins what an update does to the plugins they added.
 */
export function pluginRunsOn(builtFor: string, running: string): boolean {
  const [major, minor] = parseVersion(builtFor);
  const [ownMajor, ownMinor] = parseVersion(running);
  if (major !== ownMajor) return false;
  return major === 0 ? minor === ownMinor : minor <= ownMinor;
}

/**
 * What is wrong with the SDK's version after its API changed since a release, or null. A breaking
 * change needs a new major (a new minor while the major is 0), an addition a new minor (a new patch
 * while the major is 0), and the version never goes down.
 */
export function sdkVersionProblem(previous: SdkSnapshot, current: SdkSnapshot): string | null {
  const [before, after] = [parseVersion(previous.version), parseVersion(current.version)];
  if (compare(after, before) < 0) return `The SDK version went down, from ${previous.version} to ${current.version}.`;
  const change = classifyApiChange(previous.api, current.api);
  if (change === "none") return null;
  const [major, minor] = before;
  const pre1 = major === 0;
  const raised =
    change === "breaking"
      ? after[0] > major || (pre1 && after[1] > minor)
      : after[0] > major || after[1] > minor || (pre1 && compare(after, before) > 0);
  if (raised) return null;
  const needed = change === "breaking" ? (pre1 ? `0.${minor + 1}.0` : `${major + 1}.0.0`) : pre1 ? `0.${minor}.${before[2] + 1}` : `${major}.${minor + 1}.0`;
  return `The public API of the SDK has ${change === "breaking" ? "had something removed or changed" : "grown"} since the last release, but its version is still ${current.version} (was ${previous.version}). Raise it to at least ${needed} in packages/source-sdk/package.json, and run \`pnpm sdk-api\`.`;
}
