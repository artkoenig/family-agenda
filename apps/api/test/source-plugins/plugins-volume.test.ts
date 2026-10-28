import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sdkVersion } from "@family-agenda/source-sdk";

const apiDirectory = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../support/load-plugin-natively.ts", import.meta.url));

describe("a plugin in the plugins volume", () => {
  let plugins: string;
  beforeEach(async () => {
    plugins = await mkdtemp(join(tmpdir(), "family-agenda-plugins-"));
  });
  afterEach(async () => {
    await rm(plugins, { recursive: true, force: true });
  });

  /** A plugin as an operator drops it in, importing the SDK by its package name. */
  const writePlugin = async (name: string, packageJson: Record<string, unknown>) => {
    await mkdir(join(plugins, name));
    await writeFile(
      join(plugins, name, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        ...packageJson,
        familyAgenda: {
          sourcePlugin: { entry: "./index.ts", sourceTypeId: name, displayName: name, sdkVersion, description: "A club portal." },
        },
      }),
    );
    await writeFile(
      join(plugins, name, "index.ts"),
      `import { sdkVersion, SourceError, type SourcePlugin } from "@family-agenda/source-sdk";
export default {
  identity: { sourceTypeId: ${JSON.stringify(name)}, displayName: ${JSON.stringify(name)}, version: "1.0.0", sdkVersion },
  configuration: { version: 1, fields: [] },
  setupSteps: [],
  ingestion: { mode: "polling", suggestedIntervalSeconds: 600, poll: () => Promise.reject(SourceError.definite("wrong password")) },
  health: { silentApplies: true },
} satisfies SourcePlugin;
`,
    );
  };

  /** Loads the plugin in a Node process of its own, through Node's loader as in production. */
  const loadNatively = async (name: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script, plugins, name, name], {
      cwd: apiDirectory,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as unknown;
  };

  it("imports the SDK of the Instance, so that its errors are the core's SourceErrors", async () => {
    await writePlugin("club-portal", { type: "module" });

    expect(await loadNatively("club-portal")).toEqual({
      loaded: true,
      notLoadable: null,
      isCoreSourceError: true,
    });
  });

  it("is not loadable unless it is an ES module", async () => {
    await writePlugin("old-portal", {});

    expect(await loadNatively("old-portal")).toEqual({
      loaded: false,
      notLoadable: 'the package is no ES module; set "type": "module" in its package.json',
      isCoreSourceError: false,
    });
  });
});
