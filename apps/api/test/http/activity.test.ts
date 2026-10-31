import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

describe("The worker's activity on an Agenda over HTTP", () => {
  let instance: HttpTestInstance;
  let path: string;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest();
    await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery" });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/agendas/${created.id}`;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The worker records that it has read `done` of `total` messages. */
  const extracting = (done: number, total: number) =>
    instance.query(
      `INSERT INTO background_activities (kind, done, total, updated_at)
       VALUES ('extracting', ${done}, ${total}, '2026-09-14T06:59:00Z')`,
    );

  const indicatorOf = (page: string) => /<div id="activity"[^>]*>.*?<\/div>/s.exec(page)?.[0] ?? "";

  it("shows an empty indicator that asks again rarely while the worker is idle", async () => {
    const indicator = indicatorOf(await (await instance.get(path)).text());

    expect(indicator).toContain(`hx-get="${path}/activity"`);
    expect(indicator).toContain('hx-trigger="every 20s"');
    expect(indicator).not.toContain("spinner");
  });

  it("shows what the worker is busy with and how far it got, asking again often", async () => {
    await extracting(2, 12);

    const indicator = indicatorOf(await (await instance.get(path)).text());

    expect(indicator).toContain("Reading messages 3/12");
    expect(indicator).toContain('<progress value="2" max="12"');
    expect(indicator).toContain('hx-trigger="every 3s"');
    expect(indicator).toContain("hx-vals");
  });

  it("refreshes the timeline once the worker is done", async () => {
    const busy = await instance.get(`${path}/activity?was=busy`);
    expect(busy.headers.get("hx-trigger")).toBe("activity-ended");
    expect(await busy.text()).not.toContain("spinner");

    await extracting(0, 1);
    const still = await instance.get(`${path}/activity?was=busy`);
    expect(still.headers.get("hx-trigger")).toBeNull();
    expect(await still.text()).toContain("Reading messages 1/1");

    const page = await (await instance.get(path)).text();
    expect(page).toContain('hx-trigger="every 60s, activity-ended from:body"');
  });

  it("is not found for an unknown Agenda", async () => {
    expect((await instance.get("/agendas/00000000-0000-4000-8000-000000000000/activity")).status).toBe(404);
  });
});
