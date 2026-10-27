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
  return plugin.ingestion.poll({ config, state: null, now, timeZone: "Europe/Berlin", ...context });
};

/** Each Origin as the Item key, act and fields of its Revisions, at its source time. */
const statements = (origins: Origin[]) =>
  origins.flatMap((origin) =>
    origin.content.kind === "revisions"
      ? origin.content.revisions.map((revision) => ({
          key: revision.itemKey,
          action: revision.action,
          at: origin.occurredAt.toISOString(),
          fields: revision.fields,
        }))
      : [],
  );

describeSourcePluginContract(() => createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v1.ics"))).fetch }), {
  config,
  now,
});

describe("the ICS plugin", () => {
  it("creates an Event per calendar entry, keyed by UID, at its LAST-MODIFIED", async () => {
    const plugin = createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const { origins } = await poll(plugin);

    expect(statements(origins)).toEqual([
      {
        key: "piano-0915@google.com",
        action: "create",
        at: "2026-09-01T10:00:00.000Z",
        fields: {
          title: "Piano lesson",
          span: { allDay: false, start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T15:00:00.000Z" },
          place: "Music school, room 3",
        },
      },
      {
        key: "trip@google.com",
        action: "create",
        at: "2026-09-02T08:00:00.000Z",
        fields: { title: "Class trip", span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" }, place: null },
      },
      {
        key: "match@google.com",
        action: "create",
        at: "2026-09-03T09:00:00.000Z",
        fields: {
          title: "Football match",
          span: { allDay: false, start: "2026-09-16T15:00:00.000Z", end: "2026-09-16T16:30:00.000Z" },
          place: "Sports ground",
        },
      },
      {
        key: "fair@google.com",
        action: "create",
        at: "2026-09-04T12:00:00.000Z",
        fields: {
          title: "School fair",
          span: { allDay: false, start: "2026-09-19T08:00:00.000Z", end: "2026-09-19T10:00:00.000Z" },
          place: null,
        },
      },
      { key: "fair@google.com", action: "cancel", at: "2026-09-04T12:00:00.000Z", fields: {} },
      {
        key: "dentist@google.com",
        action: "create",
        at: "2026-09-05T12:00:00.000Z",
        fields: {
          title: "Dentist",
          span: { allDay: false, start: "2026-09-21T07:00:00.000Z", end: "2026-09-21T08:00:00.000Z" },
          place: null,
        },
      },
    ]);
  });

  it("names the calendar as an Origin attribute, and links to an entry's own address", async () => {
    const plugin = createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const [piano, trip] = (await poll(plugin)).origins;

    expect(plugin.originAttributes.map((attribute) => attribute.key)).toEqual(["calendar"]);
    expect(piano).toMatchObject({
      externalId: "piano-0915@google.com",
      attributes: { calendar: "Mia's clubs" },
      link: "https://calendar.example.org/event/piano-0915",
    });
    expect(trip?.link).toBeUndefined();
  });

  it("states only what changed since the last run: moves, changes and cancellations", async () => {
    const plugin = createIcsPlugin({
      fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v2.ics"))).fetch,
    });
    const first = await poll(plugin);
    const later = new Date("2026-09-14T08:00:00Z");

    const { origins } = await poll(plugin, { state: first.state, now: later });

    expect(statements(origins)).toEqual([
      {
        key: "piano-0915@google.com",
        action: "move",
        at: "2026-09-14T06:00:00.000Z",
        fields: { span: { allDay: false, start: "2026-09-15T15:00:00.000Z", end: "2026-09-15T16:00:00.000Z" } },
      },
      { key: "trip@google.com", action: "cancel", at: "2026-09-14T06:20:00.000Z", fields: {} },
      {
        key: "match@google.com",
        action: "change",
        at: "2026-09-14T06:10:00.000Z",
        fields: { title: "Football final", place: "Stadium" },
      },
      {
        key: "parents-evening@google.com",
        action: "create",
        at: "2026-09-14T06:30:00.000Z",
        fields: {
          title: "Parents' evening",
          span: { allDay: false, start: "2026-09-22T16:00:00.000Z", end: "2026-09-22T17:30:00.000Z" },
          place: "Assembly hall",
        },
      },
      // Deleted from the calendar: cancelled when the run noticed.
      { key: "dentist@google.com", action: "cancel", at: later.toISOString(), fields: {} },
    ]);
  });

  it("restores an entry that comes back after it was gone, later than its cancellation", async () => {
    const plugin = createIcsPlugin({
      fetch: server(
        calendar(fixture("family-v1.ics")),
        calendar(fixture("family-v2.ics")),
        calendar(fixture("family-v2.ics")),
        calendar(fixture("family-v1.ics")),
      ).fetch,
    });
    const first = await poll(plugin);
    const gone = await poll(plugin, { state: first.state, now: new Date("2026-09-14T08:00:00Z") });
    const stillGone = await poll(plugin, { state: gone.state, now: new Date("2026-09-14T08:15:00Z") });
    expect(stillGone.origins).toEqual([]);

    const back = await poll(plugin, { state: stillGone.state, now: new Date("2026-09-14T08:30:00Z") });

    expect(statements(back.origins).filter((statement) => statement.key === "dentist@google.com")).toEqual([
      {
        key: "dentist@google.com",
        action: "create",
        at: "2026-09-14T08:30:00.000Z",
        fields: {
          title: "Dentist",
          span: { allDay: false, start: "2026-09-21T07:00:00.000Z", end: "2026-09-21T08:00:00.000Z" },
          place: null,
        },
      },
    ]);
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

    const second = await poll(plugin, { state: first.state });

    expect(second).toEqual({ origins: [], state: first.state });
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

    expect(statements(origins).map(({ key, at, fields }) => [key, at, fields.span])).toEqual([
      ["named", now.toISOString(), { allDay: false, start: "2026-09-15T20:00:00.000Z", end: "2026-09-15T21:00:00.000Z" }],
      ["floating", now.toISOString(), { allDay: false, start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T15:00:00.000Z" }],
      ["no-end", now.toISOString(), { allDay: false, start: "2026-09-15T16:00:00.000Z", end: "2026-09-15T16:00:00.000Z" }],
      ["no-end-all-day", now.toISOString(), { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-18" }],
    ]);
  });

  it("knows the calendar's name for rule suggestions", async () => {
    const plugin = createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const values = await plugin.originAttributes[0]!.knownValues({ config, state: null, now, timeZone: "Europe/Berlin" });

    expect(values).toEqual([{ value: "Mia's clubs", label: "Mia's clubs" }]);
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
