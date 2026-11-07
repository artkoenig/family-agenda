import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceTypeId } from "@family-agenda/domain";
import { createDueWork } from "@family-agenda/application";
import { createWorkerLoop, type Worker } from "@family-agenda/composition";
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

  it("do not share the state of their background work", async () => {
    const warnings: string[] = [];
    const log = (name: string) => ({
      warn: (message: string) => warnings.push(`${name}: ${message}`),
      error: (message: string) => warnings.push(`${name}: ${message}`),
    });
    let release = () => {};
    const hanging = new Promise<never>((_resolve, reject) => {
      release = () => { reject(new Error("released")); };
    });
    const failing: Worker["services"]["reconcile"] = () => Promise.resolve({ failed: [{ sourceTypeId: "bridged" as SourceTypeId, message: "no program" }] });
    const blocked: Worker = {
      ...berlin.app,
      dueWork: createDueWork({ clock: berlin.clock, polling: { ...berlin.app.polling, pollDue: () => hanging }, extraction: berlin.app.extraction }),
      services: { ...berlin.app.services, reconcile: failing },
    };
    const first = createWorkerLoop(blocked, log("first"));
    const second = createWorkerLoop({ ...tokyo.app, services: { ...tokyo.app.services, reconcile: failing } }, log("second"));

    const stuck = blocked.dueWork.run();
    const secondReport = await tokyo.app.dueWork.run();
    // The second Instance ran its round although the first one's is still running.
    expect(secondReport.errors).toEqual([]);

    // A failure that stays is logged once per Instance, not once for both.
    await first.reconcile();
    await first.reconcile();
    await second.reconcile();
    await second.reconcile();
    expect(warnings.filter((line) => line.includes("Services of Source Type bridged failed"))).toHaveLength(2);

    release();
    expect((await stuck).errors).toHaveLength(1);
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
