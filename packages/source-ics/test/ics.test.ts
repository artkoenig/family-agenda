import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeSourcePluginContract } from "@family-agenda/source-sdk/testing";
import type { IngestResult, Origin, RunContext, SourcePlugin } from "@family-agenda/source-sdk";
import { createIcsPlugin } from "../src";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const url = "https://calendar.example.org/ical/secret-token/basic.ics";
const config = { plain: {}, secrets: { url } };
const now = new Date("2026-09-14T07:00:00Z");

/** A calendar server that answers every request with the next of the given responses. */
function server(...responses: (Response | Error)[]) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: input instanceof Request ? input.url : input.toString(), headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, requests };
}

const calendar = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/calendar", ...headers } });

const poll = (plugin: SourcePlugin, context: Partial<RunContext> = {}): Promise<IngestResult> => {
  if (plugin.ingestion.mode !== "polling") throw new Error("the ICS plugin polls");
  return plugin.ingestion.poll({ config, syncCursor: null, now, timeZone: "Europe/Berlin", ...context });
};

/** Each Origin as its UID and the Event it states. */
const statements = (origins: Origin[]) =>
  origins.flatMap((origin) =>
    origin.content.kind === "stated" && origin.content.stated.kind === "event" ? [{ key: origin.externalId, ...origin.content.stated }] : [],
  );

const timed = (start: string, end: string) => ({ allDay: false as const, start, end });

describeSourcePluginContract(() => createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v1.ics"))).fetch }), {
  config,
  now,
  languages: ["de"],
  packageJson: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
});

describe("the ICS plugin", () => {
  it("states each calendar entry's Event whole, keyed by UID, cancelled only by its status", async () => {
    const plugin = createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const { origins, withdrawn } = await poll(plugin);

    expect(statements(origins)).toEqual([
      {
        key: "piano-0915@google.com",
        kind: "event",
        title: "Piano lesson",
        span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"),
        place: "Music school, room 3",
        cancelled: false,
      },
      {
        key: "trip@google.com",
        kind: "event",
        title: "Class trip",
        span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" },
        place: null,
        cancelled: false,
      },
      {
        key: "match@google.com",
        kind: "event",
        title: "Football match",
        span: timed("2026-09-16T15:00:00.000Z", "2026-09-16T16:30:00.000Z"),
        place: "Sports ground",
        cancelled: false,
      },
      {
        key: "fair@google.com",
        kind: "event",
        title: "School fair",
        span: timed("2026-09-19T08:00:00.000Z", "2026-09-19T10:00:00.000Z"),
        place: null,
        cancelled: true,
      },
      {
        key: "dentist@google.com",
        kind: "event",
        title: "Dentist",
        span: timed("2026-09-21T07:00:00.000Z", "2026-09-21T08:00:00.000Z"),
        place: null,
        cancelled: false,
      },
    ]);
    expect(origins.every((origin) => origin.occurredAt === undefined)).toBe(true);
    expect(withdrawn).toEqual([]);
  });

  it("names the calendar on its Origins, and links to an entry's own address", async () => {
    const plugin = createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const [piano, trip] = (await poll(plugin)).origins;

    expect(piano).toMatchObject({
      externalId: "piano-0915@google.com",
      attributes: { calendar: "Mia's clubs" },
      link: "https://calendar.example.org/event/piano-0915",
    });
    expect(trip?.link).toBeUndefined();
  });

  it("states every entry again once the calendar changed, and withdraws those gone from it", async () => {
    const plugin = createIcsPlugin({
      fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v2.ics"))).fetch,
    });
    const first = await poll(plugin);

    const { origins, withdrawn } = await poll(plugin, { syncCursor: first.syncCursor });

    expect(statements(origins)).toEqual([
      {
        key: "piano-0915@google.com",
        kind: "event",
        title: "Piano lesson",
        span: timed("2026-09-15T15:00:00.000Z", "2026-09-15T16:00:00.000Z"),
        place: "Music school, room 3",
        cancelled: false,
      },
      {
        key: "trip@google.com",
        kind: "event",
        title: "Class trip",
        span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" },
        place: null,
        cancelled: true,
      },
      {
        key: "match@google.com",
        kind: "event",
        title: "Football final",
        span: timed("2026-09-16T15:00:00.000Z", "2026-09-16T16:30:00.000Z"),
        place: "Stadium",
        cancelled: false,
      },
      {
        key: "fair@google.com",
        kind: "event",
        title: "School fair",
        span: timed("2026-09-19T08:00:00.000Z", "2026-09-19T10:00:00.000Z"),
        place: null,
        cancelled: true,
      },
      {
        key: "parents-evening@google.com",
        kind: "event",
        title: "Parents' evening",
        span: timed("2026-09-22T16:00:00.000Z", "2026-09-22T17:30:00.000Z"),
        place: "Assembly hall",
        cancelled: false,
      },
    ]);
    // Deleted from the calendar: withdrawn, not cancelled.
    expect(withdrawn).toEqual(["dentist@google.com"]);
  });

  it("states an entry again that comes back after it was gone", async () => {
    const plugin = createIcsPlugin({
      fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v2.ics")), calendar(fixture("family-v1.ics"))).fetch,
    });
    const first = await poll(plugin);
    const gone = await poll(plugin, { syncCursor: first.syncCursor });

    const back = await poll(plugin, { syncCursor: gone.syncCursor });

    expect(statements(back.origins).map((statement) => statement.key)).toContain("dentist@google.com");
    expect(back.withdrawn).toEqual(["parents-evening@google.com"]);
  });

  it("clips texts to what an Event keeps", async () => {
    const long = "x".repeat(600);
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:long\r\nDTSTART;VALUE=DATE:20260918\r\nSUMMARY:${long}\r\nLOCATION:${long}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const plugin = createIcsPlugin({ fetch: server(calendar(body)).fetch });

    const [event] = statements((await poll(plugin)).origins);

    expect(event?.title).toHaveLength(500);
    expect(event?.place).toHaveLength(500);
  });

  it("starts afresh from a sync cursor it cannot read", async () => {
    const plugin = createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v1.ics"))).fetch });

    expect((await poll(plugin, { syncCursor: "not json" })).withdrawn).toEqual([]);
    expect((await poll(plugin, { syncCursor: JSON.stringify({ etag: null, known: "nonsense" }) })).withdrawn).toEqual([]);
  });

  it("gives up on a calendar that does not answer in time, with a temporary error", async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof globalThis.fetch;
    const plugin = createIcsPlugin({ fetch: hanging, timeoutMs: 20 });

    await expect(poll(plugin)).rejects.toMatchObject({ name: "SourceError", kind: "temporary" });
  });

  it("asks the calendar only for changes, and states nothing when there are none", async () => {
    const { fetch, requests } = server(
      calendar(fixture("family-v1.ics"), { etag: '"v1"' }),
      new Response(null, { status: 304 }),
    );
    const plugin = createIcsPlugin({ fetch });
    const first = await poll(plugin);

    const second = await poll(plugin, { syncCursor: first.syncCursor });

    expect(second).toEqual({ origins: [], syncCursor: first.syncCursor });
    expect(requests.map((request) => [request.url, request.headers.get("if-none-match")])).toEqual([
      [url, null],
      [url, '"v1"'],
    ]);
  });

  it("reads a webcal address over https, and an Admin's calendar name over the calendar's own", async () => {
    const { fetch, requests } = server(calendar(fixture("family-v1.ics")));
    const plugin = createIcsPlugin({ fetch });

    const { origins } = await poll(plugin, {
      config: { plain: { name: "Clubs" }, secrets: { url: "webcal://calendar.example.org/basic.ics" } },
    });

    expect(requests[0]?.url).toBe("https://calendar.example.org/basic.ics");
    expect(origins[0]?.attributes).toEqual({ calendar: "Clubs" });
  });

  it("places times without a known zone in their named zone, or else in the Family's", async () => {
    const entries = [
      "UID:named\r\nDTSTART;TZID=America/New_York:20260915T160000\r\nDTEND;TZID=America/New_York:20260915T170000",
      "UID:floating\r\nDTSTART:20260915T160000\r\nDTEND:20260915T170000",
      "UID:no-end\r\nDTSTART:20260915T160000Z",
      "UID:no-end-all-day\r\nDTSTART;VALUE=DATE:20260918",
    ];
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${entries
      .map((entry) => `BEGIN:VEVENT\r\n${entry}\r\nSUMMARY:Entry\r\nEND:VEVENT\r\n`)
      .join("")}END:VCALENDAR\r\n`;
    const plugin = createIcsPlugin({ fetch: server(calendar(body)).fetch });

    const { origins } = await poll(plugin);

    expect(statements(origins).map(({ key, span }) => [key, span])).toEqual([
      ["named", timed("2026-09-15T20:00:00.000Z", "2026-09-15T21:00:00.000Z")],
      ["floating", timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z")],
      ["no-end", timed("2026-09-15T16:00:00.000Z", "2026-09-15T16:00:00.000Z")],
      ["no-end-all-day", { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-18" }],
    ]);
  });

  it.each([
    { case: "an address that is gone", response: new Response("", { status: 404 }), kind: "definite" },
    { case: "a refused address", response: new Response("", { status: 403 }), kind: "definite" },
    { case: "a server error", response: new Response("", { status: 503 }), kind: "temporary" },
    { case: "an unreachable server", response: new TypeError("fetch failed"), kind: "temporary" },
    { case: "a page that is no calendar", response: calendar("<html>Sign in</html>"), kind: "definite" },
  ])("fails on $case with a $kind error", async ({ response, kind }) => {
    const plugin = createIcsPlugin({ fetch: server(response).fetch });

    await expect(poll(plugin)).rejects.toMatchObject({ name: "SourceError", kind });
  });

  it("fails definitely on an address that is no web address", async () => {
    const plugin = createIcsPlugin({ fetch: server().fetch });

    await expect(poll(plugin, { config: { plain: {}, secrets: { url: "file:///etc/passwd" } } })).rejects.toMatchObject({
      kind: "definite",
    });
  });
});
