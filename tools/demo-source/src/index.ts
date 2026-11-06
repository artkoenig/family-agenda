import { sdkVersion, type IngestContext, type IngestResult, type Origin, type SourcePlugin, type StatedItem } from "@family-agenda/source-sdk";

/** The days from the run's day on that the demo states Items for. */
const daysAhead = 7;

/**
 * The Source Attributes of the demo, which a preview assigns to the demo Family Members: a pupil's
 * timetable, a child's football club and the Family's own calendar.
 */
export const demoAttributes = [
  { externalId: "school-emma", name: "Emma, class 4b" },
  { externalId: "club-noah", name: "Noah, football" },
  { externalId: "family", name: "Family calendar" },
] as const;

type Day = { date: string; weekday: number; timeZone: string };

/**
 * States a week of made-up Events and Lessons starting on the day of the run, so that a preview
 * always shows an Agenda with something on today and in the days ahead. It is a developer tool
 * (`pnpm preview`) and lives outside `packages/`, so an Instance only finds it when a preview
 * mounts it into the plugins directory.
 */
export function createDemoPlugin(): SourcePlugin {
  return {
    identity: { sourceTypeId: "demo", displayName: { en: "Demo data", de: "Demodaten" }, version: "0.1.0", sdkVersion },
    configuration: { version: 1, fields: [] },
    setupSteps: [],
    ingestion: {
      mode: "polling",
      suggestedIntervalSeconds: 3600,
      async poll(context: IngestContext): Promise<IngestResult> {
        await context.attributes.declare([...demoAttributes]);
        return { origins: originsFor(daysFrom(context.now, context.timeZone)), syncCursor: null };
      },
    },
    health: { silentApplies: false },
  };
}

export default createDemoPlugin();

function originsFor(days: Day[]): Origin[] {
  return days.flatMap((day, index) => [...lessonsOn(day), ...clubOn(day), ...familyOn(day, index)]);
}

function origin(externalId: string, attribute: string, stated: StatedItem): Origin {
  return { externalId, attributes: [attribute], content: { kind: "stated", stated } };
}

function lessonsOn(day: Day): Origin[] {
  if (day.weekday === 0 || day.weekday === 6) return [];
  const lesson = (n: number, subject: string, start: string, end: string, room: string, teacher: string, change: Partial<Lesson> = {}): Origin =>
    origin(`lesson-${day.date}-${n}`, "school-emma", {
      kind: "lesson",
      subject,
      span: { allDay: false, start: at(day, start), end: at(day, end) },
      room,
      teacher,
      change: null,
      previousRoom: null,
      previousTeacher: null,
      note: null,
      ...change,
    });
  const lessons = [
    lesson(1, "Mathematics", "08:00", "08:45", "101", "Ms Weber"),
    lesson(2, "German", "08:55", "09:40", "101", "Ms Weber"),
    lesson(3, "Sport", "10:00", "10:45", "Gym", "Mr Keller"),
  ];
  // The teacher of the first lesson is away on Wednesdays, and the gym is closed on Fridays.
  if (day.weekday === 3) {
    lessons[0] = lesson(1, "Mathematics", "08:00", "08:45", "101", "Mr Braun", { change: "substitution", previousTeacher: "Ms Weber", note: "Ms Weber is ill." });
  }
  if (day.weekday === 5) {
    lessons[2] = lesson(3, "Sport", "10:00", "10:45", "Gym", "Mr Keller", { change: "cancellation", note: "The gym is closed." });
  }
  return lessons;
}

type Lesson = Extract<StatedItem, { kind: "lesson" }>;

function clubOn(day: Day): Origin[] {
  const training = day.weekday === 2 || day.weekday === 4;
  if (training) return [event(`training-${day.date}`, "club-noah", "Football training", at(day, "17:00"), at(day, "18:30"), "Sports field")];
  if (day.weekday === 6) return [event(`match-${day.date}`, "club-noah", "Football match", at(day, "10:00"), at(day, "12:00"), "Town stadium")];
  return [];
}

function familyOn(day: Day, index: number): Origin[] {
  if (index === 2) return [event(`dentist-${day.date}`, "family", "Dentist", at(day, "15:30"), at(day, "16:15"), "Dr Schmidt")];
  if (index === 5) {
    return [origin(`birthday-${day.date}`, "family", { kind: "event", title: "Grandma's birthday", span: { allDay: true, firstDay: day.date, lastDay: day.date }, place: null, cancelled: false })];
  }
  return [];
}

function event(externalId: string, attribute: string, title: string, start: string, end: string, place: string): Origin {
  return origin(externalId, attribute, { kind: "event", title, span: { allDay: false, start, end }, place, cancelled: false });
}

/** The calendar days from the one `now` falls on in the Family's time zone, `daysAhead` of them. */
function daysFrom(now: Date, timeZone: string): Day[] {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now).split("-").map(Number) as [number, number, number];
  return Array.from({ length: daysAhead }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    return { date: date.toISOString().slice(0, 10), weekday: date.getUTCDay(), timeZone };
  });
}

/** The instant a wall-clock time on a date is in the zone the Family lives in, as an ISO 8601 string. */
function at(day: Day, time: string): string {
  const wall = Date.parse(`${day.date}T${time}:00Z`);
  const first = wall - offsetOf(wall, day.timeZone);
  return new Date(wall - offsetOf(first, day.timeZone)).toISOString();
}

/** How far ahead of UTC the zone's clocks are at an instant, in milliseconds. */
function offsetOf(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return local - Math.floor(instant / 1000) * 1000;
}
