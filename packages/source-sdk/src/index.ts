/**
 * The contract a Source plugin implements (ADR-0010). It is the only Family Butler package a
 * plugin may import. Later tickets add configuration, setup steps, ingestion and health.
 */
export const sdkVersion = "0.1.0";

export type SourcePluginIdentity = {
  /** Stable id of the Source Type, such as `ics`. Never changes once released. */
  sourceTypeId: string;
  displayName: string;
  /** The plugin's own version. */
  version: string;
  /** The `sdkVersion` the plugin was built against. */
  sdkVersion: string;
};

export interface SourcePlugin {
  identity: SourcePluginIdentity;
}

const sourceTypeIdPattern = /^[a-z][a-z0-9-]*$/;

/** Problems that keep a plugin from being loaded, such as an incompatible SDK version. */
export function problemsWith(plugin: SourcePlugin): string[] {
  const { identity } = plugin;
  const problems: string[] = [];
  if (!sourceTypeIdPattern.test(identity.sourceTypeId)) {
    problems.push(`Source Type id "${identity.sourceTypeId}" is not lowercase kebab-case`);
  }
  if (identity.displayName.trim() === "") problems.push("display name is empty");
  if (majorOf(identity.sdkVersion) !== majorOf(sdkVersion)) {
    problems.push(`built for SDK ${identity.sdkVersion}, but this is SDK ${sdkVersion}`);
  }
  return problems;
}

/** The compatibility-relevant part of a version: the major, or the minor while the major is 0. */
function majorOf(version: string): string {
  const [major, minor] = version.split(".");
  return major === "0" ? `0.${minor}` : (major ?? "");
}
