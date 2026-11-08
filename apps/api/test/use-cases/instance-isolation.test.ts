import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkerHandler, createWorkerService, createWorkScheduler, WorkerClient, type Worker } from "@family-agenda/composition";
import { bootForTest, type TestInstance } from "../support/boot";

const password = "correct horse battery";

describe("two Instances in one process", () => {
  let berlin: TestInstance;
  let tokyo: TestInstance;
  beforeEach(async () => {
    berlin = await bootForTest({ timeZone: "Europe/Berlin" });
    tokyo = await bootForTest({ timeZone: "Asia/Tokyo" });
  });
  afterEach(async () => {
    await berlin.close();
    await tokyo.close();
  });

  it("do not see each other's data", async () => {
    await berlin.app.admins.createFirstAdmin({ email: "anna@example.org", password });

    expect(await berlin.app.admins.needsFirstAdmin()).toBe(false);
    expect(await tokyo.app.admins.needsFirstAdmin()).toBe(true);
    expect(await tokyo.query("SELECT * FROM admin")).toEqual([]);
  });

  it("do not accept each other's sessions", async () => {
    const created = await berlin.app.admins.createFirstAdmin({ email: "anna@example.org", password });
    if (!created.ok) throw new Error("the first Admin was not created");
    await tokyo.app.admins.createFirstAdmin({ email: "anna@example.org", password });

    expect((await berlin.app.admins.authenticate(created.sessionToken))?.email).toBe("anna@example.org");
    expect(await tokyo.app.admins.authenticate(created.sessionToken)).toBeNull();
  });

  it("share one worker without sharing the state of their background work", async () => {
    const warnings: string[] = [];
    const log = (name: string) => ({
      warn: (message: string) => warnings.push(`${name}: ${message}`),
      error: (message: string) => warnings.push(`${name}: ${message}`),
    });
    let release = () => {};
    const hanging = new Promise<never>((_resolve, reject) => {
      release = () => { reject(new Error("released")); };
    });
    const instances: Record<string, Worker> = {
      "postgres://berlin": { ...berlin.app, polling: { ...berlin.app.polling, pollDue: () => hanging } },
      "postgres://tokyo": tokyo.app,
    };
    // One worker, which knows neither Family until each triggers it with its database.
    const handler = createWorkerHandler(
      createWorkerService((family) => Promise.resolve(instances[family.databaseUrl] as Worker)),
      "token",
    );
    const worker = new WorkerClient({ url: "http://worker:4200", token: "token", fetch: (input, init) => handler(new Request(input, init)) });
    const family = (name: string, timeZone: string) => ({ databaseUrl: `postgres://${name}`, masterKey: Buffer.alloc(32), blobDirectory: `/blobs/${name}`, timeZone });
    const first = createWorkScheduler({ worker, family: family("berlin", "Europe/Berlin"), log: log("first") });
    const second = createWorkScheduler({ worker, family: family("tokyo", "Asia/Tokyo"), log: log("second") });

    const stuck = first.round();
    // The second Family's round runs on the same worker although the first one's is still running.
    expect(await second.round()).toBeGreaterThanOrEqual(0);
    expect(warnings).toEqual([]);

    release();
    await stuck;
    expect(warnings).toContain("first: Polling Sources failed:");
    await Promise.all([first.stop(), second.stop()]);
  });

  it("keep their own configuration", () => {
    expect(berlin.app.timeZone).toBe("Europe/Berlin");
    expect(tokyo.app.timeZone).toBe("Asia/Tokyo");
  });

  it("go on working when the other is closed", async () => {
    await berlin.app.close();

    const created = await tokyo.app.admins.createFirstAdmin({ email: "anna@example.org", password });
    expect(created.ok).toBe(true);
    expect(await tokyo.app.admins.needsFirstAdmin()).toBe(false);
  });
});
