import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The wrapper the Dockerfile installs; it runs against /app, which holds only the production dependencies. */
const command = "/usr/local/bin/logto-setup";

describe("the logto-setup command the image ships", () => {
  it("starts and names the settings it misses", (context) => {
    if (!existsSync(command)) {
      if (process.env.CI) throw new Error(`${command} is missing from the image`);
      context.skip();
    }
    const result = spawnSync(command, [], { encoding: "utf8", env: { PATH: process.env.PATH } });

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).toContain("Missing: LOGTO_M2M_APP_ID");
    expect(result.status).toBe(1);
  });
});
