import { PGlite } from "@electric-sql/pglite";
import { fromPglite, TestClock } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";
import { PgBossWorkSchedule } from "../src/pg-boss-work-schedule";

const opened: PgBossWorkSchedule[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((schedule) => schedule.stop()));
});

async function workerOn(postgres: PGlite, clock: TestClock): Promise<PgBossWorkSchedule> {
  const schedule = new PgBossWorkSchedule({ db: fromPglite(postgres), backend: "pglite", clock });
  opened.push(schedule);
  await schedule.start();
  return schedule;
}

/** Lets the handlers a tick handed jobs to run, on real time, then moves the clock on. */
async function minutes(clock: TestClock, count: number): Promise<void> {
  for (let i = 0; i < count * 12; i++) {
    await clock.tick(5_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("work run from pg-boss schedules", () => {
  it("runs work on each occurrence of its schedule", async () => {
    const clock = new TestClock("2026-11-15T10:00:30Z");
    const schedule = await workerOn(await PGlite.create(), clock);
    let runs = 0;

    await schedule.every("count", "* * * * *", () => {
      runs++;
      return Promise.resolve();
    });
    await minutes(clock, 3);

    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBeLessThanOrEqual(3);
  });

  it("does not start an occurrence while the previous run of the same work is still going", async () => {
    const postgres = await PGlite.create();
    const clock = new TestClock("2026-11-15T10:00:30Z");
    // A second worker would take the next occurrence if one were sent while the first is busy.
    const workers = [await workerOn(postgres, clock), await workerOn(postgres, clock)];
    let started = 0;
    let finish = () => {};
    const going = new Promise<void>((resolve) => (finish = resolve));

    for (const worker of workers) {
      await worker.every("slow", "* * * * *", () => {
        started++;
        return going;
      });
    }
    await minutes(clock, 4);
    finish();

    expect(started).toBe(1);
  });

  it("runs each occurrence once across two workers on one database", async () => {
    const postgres = await PGlite.create();
    const clock = new TestClock("2026-11-15T10:00:30Z");
    const first = await workerOn(postgres, clock);
    const second = await workerOn(postgres, clock);
    const runs: string[] = [];

    await first.every("count", "* * * * *", () => {
      runs.push("first");
      return Promise.resolve();
    });
    await second.every("count", "* * * * *", () => {
      runs.push("second");
      return Promise.resolve();
    });
    await minutes(clock, 3);

    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.length).toBeLessThanOrEqual(3);
  });

  it("runs work once when asked to", async () => {
    const clock = new TestClock("2026-11-15T10:00:30Z");
    const schedule = await workerOn(await PGlite.create(), clock);
    let runs = 0;

    await schedule.now("sweep", () => {
      runs++;
      return Promise.resolve();
    });
    await minutes(clock, 2);

    expect(runs).toBe(1);
  });
});
