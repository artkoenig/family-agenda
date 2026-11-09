import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Oasdiff } from "./contract";

/** The level from which each command counts a finding: an error is breaking, any entry a change. */
const failOn = { breaking: "ERR", changelog: "INFO" } as const;

/**
 * The `oasdiff` of the PATH, as the CI job installs it. With `--fail-on` it exits 1 when it found
 * something at that level; any other failure is its own and is thrown.
 */
export const oasdiff: Oasdiff = (command, base, revision) => {
  const directory = mkdtempSync(join(tmpdir(), "contract-"));
  try {
    writeFileSync(join(directory, "base.json"), base);
    writeFileSync(join(directory, "revision.json"), revision);
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync("oasdiff", [command, join(directory, "base.json"), join(directory, "revision.json"), "--fail-on", failOn[command]], { stdio: ["ignore", "inherit", "inherit"] });
    return false;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return true;
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
