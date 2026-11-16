import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFamily, retriedOnLockTimeout } from "../src";

const folders: string[] = [];
const databases: PGlite[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((postgres) => postgres.close()));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

/** A migrations folder of one migration that keeps the lock timeout it ran under. */
async function recordingMigrations(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "migrations-"));
  folders.push(folder);
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1, tag: "0000_seen", breakpoints: true }] }));
  await writeFile(join(folder, "0000_seen.sql"), "CREATE TABLE seen AS SELECT current_setting('lock_timeout') AS lock_timeout;");
  return folder;
}

const lockNotAvailable = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

describe("a migration", () => {
  it("runs under the lock timeout given, and leaves the session's own setting as it was", async () => {
    const postgres = await PGlite.create();
    databases.push(postgres);

    await migrateFamily(drizzle(postgres), await recordingMigrations(), undefined, { lockTimeoutMs: 5_000 });

    expect((await postgres.query("SELECT lock_timeout FROM seen")).rows).toEqual([{ lock_timeout: "5s" }]);
    expect((await postgres.query("SELECT current_setting('lock_timeout') AS value")).rows).toEqual([{ value: "0" }]);
  });

  it("is tried again when it timed out waiting for a lock, wrapped in the driver's error or not", async () => {
    const failures = [lockNotAvailable(), Object.assign(new Error("Failed query"), { cause: lockNotAvailable() })];
    let tries = 0;

    const result = await retriedOnLockTimeout(
      () => {
        tries += 1;
        const failure = failures.shift();
        return failure ? Promise.reject(failure) : Promise.resolve("migrated");
      },
      { attempts: 3, pauseMs: 1 },
    );

    expect(result).toBe("migrated");
    expect(tries).toBe(3);
  });

  it("gives up after the attempts given, and is not tried again for another error", async () => {
    let tries = 0;
    const timingOut = () => {
      tries += 1;
      return Promise.reject(lockNotAvailable());
    };

    await expect(retriedOnLockTimeout(timingOut, { attempts: 2, pauseMs: 1 })).rejects.toMatchObject({ code: "55P03" });
    expect(tries).toBe(2);

    tries = 0;
    const failing = () => {
      tries += 1;
      return Promise.reject(new Error("syntax error"));
    };
    await expect(retriedOnLockTimeout(failing, { attempts: 3, pauseMs: 1 })).rejects.toThrow("syntax error");
    expect(tries).toBe(1);
  });
});
