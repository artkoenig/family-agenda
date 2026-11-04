import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeSourcePluginContract, recordingAttributes } from "@family-agenda/source-sdk/testing";
import type { IngestResult, Origin, RunContext, SourcePlugin } from "@family-agenda/source-sdk";
import { createWebUntisPlugin } from "../src";

type Json = Record<string, unknown>;

const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Json;

// The RFC 6238 test secret, "12345678901234567890" in Base32.
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const config = { plain: { server: "park.webuntis.com", school: "gym-am-park", user: "anna.koenig" }, secrets: { secret } };
// Monday 2026-09-14 at 09:00 in Berlin.
const now = new Date("2026-09-14T07:00:00Z");

type Call = { url: URL; body: { method: string; params: Json[] } };

/**
 * A WebUntis server answering the mobile API with recorded responses: the parent's children, and
 * each child's Timetable, which a test may change between runs.
 */
function server(timetables: Record<number, Json> = { 1201: fixture("timetable-mia.json"), 1202: fixture("timetable-leo.json") }) {
  const requests: Call[] = [];
  const answers: { userData: Json | Response | Error } = { userData: fixture("user-data.json") };
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(init?.body as string) as Call["body"];
    requests.push({ url, body });
    if (body.method === "getUserData2017") {
      const answer = answers.userData;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer instanceof Response ? answer : Response.json(answer));
    }
    if (body.method === "getTimetable2017") {
      const timetable = timetables[Number(body.params[0]?.id)];
      return Promise.resolve(Response.json(timetable ?? { jsonrpc: "2.0", id: "family-agenda", error: { code: -7004, message: "no right for timetable" } }));
    }
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: "family-agenda", error: { code: -32601, message: "Method not found" } }));
  };
  return { fetch, requests, answers, timetables };
}

const poll = (plugin: SourcePlugin, context: Partial<RunContext> = {}): Promise<IngestResult> => {
  if (plugin.ingestion.mode !== "polling") throw new Error("the WebUntis plugin polls");
  return plugin.ingestion.poll({ config, syncCursor: null, now, timeZone: "Europe/Berlin", attributes: recordingAttributes(), ...context });
};

/** Each Origin as its key and the Lesson it states. */
const statements = (origins: Origin[]) =>
  origins.flatMap((origin) =>
    origin.content.kind === "stated" && origin.content.stated.kind === "lesson" ? [{ key: origin.externalId, ...origin.content.stated }] : [],
  );

/** A Lesson as planned, without a Timetable Change. */
const asPlanned = { change: null, previousRoom: null, previousTeacher: null, note: null };

/** A Lesson of a recorded Timetable, which Untis calls a period, to change it between runs. */
const lessonIn = (timetable: Json, id: number) =>
  ((timetable.result as Json).timetable as { periods: Json[] }).periods.find((period) => period.id === id)!;

/** Berlin is two hours ahead of UTC in September. */
const span = (day: string, from: string, until: string) => ({
  allDay: false,
  start: new Date(`${day}T${from}:00+02:00`).toISOString(),
  end: new Date(`${day}T${until}:00+02:00`).toISOString(),
});

describeSourcePluginContract(() => createWebUntisPlugin({ fetch: server().fetch }), {
  config,
  now,
  languages: ["de"],
  packageJson: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
});

describe("the WebUntis plugin", () => {
  it("logs in with a one-time password from the QR secret, lists the children and asks for each one's Timetable as a STUDENT", async () => {
    const untis = server();

    // RFC 6238 gives 081804 for its test secret at this time.
    await poll(createWebUntisPlugin({ fetch: untis.fetch }), { now: new Date(1111111109 * 1000) });

    expect(untis.requests.map(({ url, body }) => ({ url: `${url.origin}${url.pathname}`, school: url.searchParams.get("school"), method: body.method }))).toEqual([
      { url: "https://park.webuntis.com/WebUntis/jsonrpc_intern.do", school: "gym-am-park", method: "getUserData2017" },
      { url: "https://park.webuntis.com/WebUntis/jsonrpc_intern.do", school: "gym-am-park", method: "getTimetable2017" },
      { url: "https://park.webuntis.com/WebUntis/jsonrpc_intern.do", school: "gym-am-park", method: "getTimetable2017" },
    ]);
    for (const { body } of untis.requests) {
      expect(body.params[0]?.auth).toEqual({ user: "anna.koenig", otp: 81804, clientTime: 1111111109000 });
    }
    expect(untis.requests.slice(1).map(({ body }) => ({ ...body.params[0], auth: undefined }))).toMatchObject([
      { id: 1201, type: "STUDENT", startDate: 20050318, endDate: 20050331 },
      { id: 1202, type: "STUDENT", startDate: 20050318, endDate: 20050331 },
    ]);
  });

  it("states each child's Lessons whole, keyed by child and the id Untis gives the Lesson, with how they deviate from the Timetable", async () => {
    const { origins } = await poll(createWebUntisPlugin({ fetch: server().fetch }));

    expect(statements(origins)).toEqual([
      {
        key: "1201/90001",
        kind: "lesson",
        subject: "Mathematik",
        span: span("2026-09-15", "08:00", "08:45"),
        room: "101",
        teacher: "Jonas Brandt",
        ...asPlanned,
      },
      {
        key: "1201/90002",
        kind: "lesson",
        subject: "Englisch",
        span: span("2026-09-15", "08:50", "09:35"),
        room: "102",
        teacher: "Sara Weber",
        change: "substitution",
        previousRoom: null,
        previousTeacher: "Petra Roth",
        note: "Vertretung",
      },
      {
        key: "1201/90003",
        kind: "lesson",
        subject: "Physik",
        span: span("2026-09-15", "09:55", "10:40"),
        room: "PH1",
        teacher: "Eva Lang",
        change: "cancellation",
        previousRoom: null,
        previousTeacher: null,
        note: "Lehrkraft erkrankt",
      },
      {
        key: "1201/90004",
        kind: "lesson",
        subject: "Mathematik",
        span: span("2026-09-16", "08:00", "08:45"),
        room: "204",
        teacher: "Jonas Brandt",
        change: "room-change",
        previousRoom: "101",
        previousTeacher: null,
        note: null,
      },
      // The school withholds its teachers from Leo's parents.
      {
        key: "1202/91001",
        kind: "lesson",
        subject: "Kunst",
        span: span("2026-09-15", "08:00", "09:35"),
        room: "KU1",
        teacher: null,
        ...asPlanned,
      },
    ]);
    expect(origins.map((origin) => [origin.externalId, origin.attributes])).toContainEqual(["1202/91001", ["account"]]);
    expect(origins.every((origin) => origin.occurredAt === undefined)).toBe(true);
  });

  it("states a Lesson as planned again once the school takes its cancellation back", async () => {
    const untis = server();
    const plugin = createWebUntisPlugin({ fetch: untis.fetch });
    const first = await poll(plugin);
    const physics = lessonIn(untis.timetables[1201]!, 90003);
    physics.is = ["STANDARD"];
    physics.text = { lesson: "", substitution: "", info: "" };

    const { origins } = await poll(plugin, { syncCursor: first.syncCursor });

    expect(statements(origins).find((statement) => statement.key === "1201/90003")).toEqual({
      key: "1201/90003",
      kind: "lesson",
      subject: "Physik",
      span: span("2026-09-15", "09:55", "10:40"),
      room: "PH1",
      teacher: "Eva Lang",
      ...asPlanned,
    });
  });

  it("states every Lesson again on each run, and withdraws a Lesson gone from the Timetable", async () => {
    const untis = server();
    const plugin = createWebUntisPlugin({ fetch: untis.fetch });
    const first = await poll(plugin);
    const timetable = (untis.timetables[1201]!.result as Json).timetable as { periods: Json[] };
    timetable.periods = timetable.periods.filter((period) => period.id !== 90001);
    const maths = lessonIn(untis.timetables[1201]!, 90004);
    maths.startDateTime = "2026-09-16T08:50Z";
    maths.endDateTime = "2026-09-16T09:35Z";

    const { origins, withdrawn } = await poll(plugin, { syncCursor: first.syncCursor });

    expect(statements(origins).map((statement) => statement.key)).toEqual(["1201/90002", "1201/90003", "1201/90004", "1202/91001"]);
    expect(statements(origins).find((statement) => statement.key === "1201/90004")?.span).toEqual(span("2026-09-16", "08:50", "09:35"));
    expect(withdrawn).toEqual(["1201/90001"]);
  });

  it("clips texts to what a Lesson keeps", async () => {
    const untis = server();
    const physics = lessonIn(untis.timetables[1201]!, 90003);
    physics.text = { lesson: "", substitution: "", info: `  ${"x".repeat(300)}` };

    const { origins } = await poll(createWebUntisPlugin({ fetch: untis.fetch }));

    expect(statements(origins).find((statement) => statement.key === "1201/90003")?.note).toBe("x".repeat(200));
  });

  it("starts afresh from a sync cursor it cannot read", async () => {
    const plugin = createWebUntisPlugin({ fetch: server().fetch });

    expect((await poll(plugin, { syncCursor: "not json" })).withdrawn).toEqual([]);
    expect((await poll(plugin, { syncCursor: JSON.stringify({ children: [], known: "nonsense" }) })).withdrawn).toEqual([]);
  });

  it("forgets past Lessons without cancelling them", async () => {
    const untis = server();
    const plugin = createWebUntisPlugin({ fetch: untis.fetch });
    const first = await poll(plugin);
    // On Thursday, Tuesday and Wednesday have passed and the Timetable starts with Thursday.
    for (const id of [1201, 1202]) ((untis.timetables[id]!.result as Json).timetable as { periods: Json[] }).periods = [];

    const { origins, withdrawn } = await poll(plugin, { syncCursor: first.syncCursor, now: new Date("2026-09-17T07:00:00Z") });

    expect(origins).toEqual([]);
    expect(withdrawn).toEqual([]);
  });

  it("reads only the children ticked on the Source, and offers the children of the account to tick", async () => {
    const untis = server();
    const plugin = createWebUntisPlugin({ fetch: untis.fetch });
    const leoOnly = { ...config, plain: { ...config.plain, children: ["1202"] } };

    const { origins, syncCursor } = await poll(plugin, { config: leoOnly });

    expect(new Set(origins.map((origin) => origin.externalId.split("/")[0]))).toEqual(new Set(["1202"]));
    const field = plugin.configuration.fields.find((candidate) => candidate.key === "children");
    expect(await field?.choices?.({ config: leoOnly, syncCursor, now, timeZone: "Europe/Berlin" })).toEqual([
      { value: "1201", label: "Mia König" },
      { value: "1202", label: "Leo König" },
    ]);
  });

  it("withdraws the coming Lessons of a child no longer ticked", async () => {
    const plugin = createWebUntisPlugin({ fetch: server().fetch });
    const first = await poll(plugin);

    const { origins, withdrawn } = await poll(plugin, { config: { ...config, plain: { ...config.plain, children: ["1201"] } }, syncCursor: first.syncCursor });

    expect(new Set(origins.map((origin) => origin.externalId.split("/")[0]))).toEqual(new Set(["1201"]));
    expect(withdrawn).toEqual(["1202/91001"]);
  });

  it("fails definitely when WebUntis refuses the login, and temporarily when it cannot be reached", async () => {
    const untis = server();
    const plugin = createWebUntisPlugin({ fetch: untis.fetch });

    untis.answers.userData = { jsonrpc: "2.0", id: "family-agenda", error: { code: -8504, message: "bad credentials" } };
    await expect(poll(plugin)).rejects.toMatchObject({ kind: "definite", message: expect.stringContaining("bad credentials") as unknown });

    untis.answers.userData = new Response("Bad gateway", { status: 502 });
    await expect(poll(plugin)).rejects.toMatchObject({ kind: "temporary" });

    untis.answers.userData = new Error("connect ETIMEDOUT");
    await expect(poll(plugin)).rejects.toMatchObject({ kind: "temporary", message: expect.stringContaining("ETIMEDOUT") as unknown });
  });

  it("reads the account's own Timetable when it is a student's", async () => {
    const untis = server();
    const userData = fixture("user-data.json");
    Object.assign((userData.result as Json).userData as Json, { children: [], elemType: "STUDENT", elemId: 1201, displayName: "Mia" });
    untis.answers.userData = userData;

    const { origins } = await poll(createWebUntisPlugin({ fetch: untis.fetch }));

    expect(new Set(origins.map((origin) => origin.externalId.split("/")[0]))).toEqual(new Set(["1201"]));
  });

  it("fails temporarily when WebUntis answers without the account's data", async () => {
    const untis = server();
    untis.answers.userData = { jsonrpc: "2.0", id: "family-agenda", result: {} };

    await expect(poll(createWebUntisPlugin({ fetch: untis.fetch }))).rejects.toMatchObject({ kind: "temporary" });
  });

  it("fails definitely when the account lists no children", async () => {
    const untis = server();
    const userData = fixture("user-data.json");
    ((userData.result as Json).userData as Json).children = [];
    untis.answers.userData = userData;

    await expect(poll(createWebUntisPlugin({ fetch: untis.fetch }))).rejects.toMatchObject({ kind: "definite" });
  });
});
