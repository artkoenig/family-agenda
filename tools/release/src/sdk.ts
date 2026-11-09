/** The version of the SDK at a release. */
export type SdkSnapshot = { version: string };

type Version = [major: number, minor: number, patch: number];

function parseVersion(version: string): Version {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (parts === null) throw new Error(`"${version}" is no version like 1.2.3`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

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
