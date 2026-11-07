import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { bootApplication, type Adapters } from "@family-agenda/composition";
import { acquirePostgres, type InProcessPostgres } from "./support/in-process-postgres";

describe("booting an Application", () => {
  let postgres: InProcessPostgres | undefined;
  afterEach(async () => {
    await postgres?.release();
    postgres = undefined;
  });

  /** Adapters that fail the test should booting touch anything but the connection. */
  const adaptersOver = async (masterKey: Buffer): Promise<{ adapters: Adapters; closed: () => boolean }> => {
    postgres = await acquirePostgres();
    const connection = postgres.connect();
    let closed = false;
    const adapters = {
      postgres: { ...connection, close: () => { closed = true; return Promise.resolve(); } },
      masterKey,
    } as Adapters;
    return { adapters, closed: () => closed };
  };

  it("fails with a clear message for a time zone Intl does not know, and lets go of the connection", async () => {
    const { adapters, closed } = await adaptersOver(randomBytes(32));
    await expect(bootApplication({ timeZone: "Mars/Olympus" }, adapters)).rejects.toThrow(/not an IANA time zone/);
    expect(closed()).toBe(true);
  });

  it("fails with a clear message for a master key of the wrong length", async () => {
    const { adapters, closed } = await adaptersOver(randomBytes(16));
    await expect(bootApplication({ timeZone: "Europe/Berlin" }, adapters)).rejects.toThrow(/master key must be 32 bytes, not 16/);
    expect(closed()).toBe(true);
  });
});
