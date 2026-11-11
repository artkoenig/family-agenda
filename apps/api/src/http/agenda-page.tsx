import type {
  CurrentActivity,
  FamilyMemberSummary,
  MessageItemRows,
  Showing,
  TaskListPage,
  TimelineDays,
  TimelineDay,
  TimelineEvent,
  TimelineSchoolDay,
  TimelineTask,
  TimelineTimetableChange,
  AgendaPage,
} from "@family-agenda/application";
import { addDays, daysBetween, type FamilyMemberId, type LocalDate } from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Catalogue } from "./i18n/en";
import { useTranslation, type Translation } from "./i18n/translation";
import { Layout } from "./layout";
import { avatarUrl } from "./avatars";

// The Agenda layouts: a vertical timeline, or a Task List, that works on a phone, a
// desktop and a wall tablet, in the Family Agenda design system (`design/design.css`).

/** Where the manifest of an Agenda is. */
const manifestOf = (page: { id: string }) => `/agendas/${page.id}/manifest.webmanifest`;

export function AgendaPageDocument(props: { page: AgendaPage }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.agenda.title} surface="agenda" manifest={manifestOf(props.page)}>
      <AgendaTimeline page={props.page} />
      <button type="button" id="back-to-today" class="fam-button fam-button--primary fam-button--pill fam-back-to-today" hidden>
        <span class="fam-back-to-today__arrow" aria-hidden="true">↑</span>
        {t.agenda.today}
      </button>
      <script>{raw(agendaBar + backToToday)}</script>
    </Layout>
  );
}

/**
 * Folds the top bar into one line once the page is scrolled, on a phone, and unfolds it near the
 * top again; there the filter hides behind the avatars of those shown, which open it. The state
 * sits on the body, outside the part htmx swaps, so that a refresh or a filter change keeps it.
 * Without JavaScript the bar stays whole. It folds at one scroll position and unfolds at another,
 * so that its own change of height cannot toggle it back and forth.
 */
const agendaBar = `
const foldAt = 120;
const unfoldAt = 8;
let folded = false;
const syncSummary = () => {
  const open = document.body.classList.contains("fam-filter-open");
  for (const button of document.querySelectorAll(".fam-bar__summary")) button.setAttribute("aria-expanded", String(open));
};
const fold = () => {
  const next = folded ? window.scrollY > unfoldAt : window.scrollY > foldAt;
  if (next === folded) return;
  folded = next;
  document.body.classList.toggle("fam-scrolled", folded);
  if (!folded) document.body.classList.remove("fam-filter-open");
  syncSummary();
  document.dispatchEvent(new Event("fam-bar-resized"));
};
window.addEventListener("scroll", fold, { passive: true });
document.addEventListener("click", (event) => {
  if (!event.target.closest(".fam-bar__summary")) return;
  document.body.classList.toggle("fam-filter-open");
  syncSummary();
  document.dispatchEvent(new Event("fam-bar-resized"));
});
// Marks the quick filter new choice at once, as the server will, so that its switches slide
// during the 250 ms before htmx swaps the bar in.
document.addEventListener("click", (event) => {
  const item = event.target.closest(".fam-filter__item");
  if (!item || event.button || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const [all, ...members] = item.parentElement.querySelectorAll(".fam-filter__item");
  const mark = (element, on) => (on ? element.setAttribute("aria-current", "true") : element.removeAttribute("aria-current"));
  if (item === all || all.hasAttribute("aria-current")) {
    for (const member of members) mark(member, member === item);
    mark(all, item === all);
  } else {
    mark(item, !item.hasAttribute("aria-current"));
    const chosen = members.filter((member) => member.hasAttribute("aria-current"));
    const everyone = chosen.length === 0 || chosen.length === members.length;
    if (everyone) for (const member of members) mark(member, false);
    mark(all, everyone);
  }
});
// A swap brings a new row of pills, which starts at the left again: it goes back to where it was.
let filterScroll = 0;
document.addEventListener("scroll", (event) => {
  if (event.target.classList?.contains("fam-filter")) filterScroll = event.target.scrollLeft;
}, true);
document.body.addEventListener("htmx:afterSettle", () => {
  const filter = document.querySelector(".fam-filter");
  if (filter) {
    filter.scrollLeft = filterScroll;
    // The chosen pill has grown: if it now reaches past the edge, the row scrolls on to show it.
    const chosen = [...filter.querySelectorAll("[aria-current]")].pop();
    if (chosen) filter.scrollLeft += Math.max(0, chosen.getBoundingClientRect().right + 28 - filter.getBoundingClientRect().right);
  }
  syncSummary();
});
fold();
syncSummary();
`;

/**
 * Shows the button back to today while today is scrolled out of sight, below the top bar, with an
 * arrow towards it, below the bar again when it folds or unfolds. It sits outside the part htmx swaps, and watches today again after each swap,
 * because a refresh or a quick filter change brings a new one.
 */
const backToToday = `
const back = document.getElementById("back-to-today");
const arrow = back.querySelector(".fam-back-to-today__arrow");
const barHeight = () => document.querySelector(".fam-bar")?.offsetHeight ?? 0;
let observer = null;
let today = null;
const watch = () => {
  const next = document.querySelector(".fam-day--today");
  if (next === today && observer) return;
  observer?.disconnect();
  today = next;
  back.hidden = true;
  if (!today) return;
  observer = new IntersectionObserver(([entry]) => {
    back.hidden = entry.isIntersecting;
    arrow.textContent = entry.boundingClientRect.top < entry.rootBounds.top ? "↑" : "↓";
  }, { rootMargin: "-" + barHeight() + "px 0px 0px 0px" });
  observer.observe(today);
};
watch();
document.body.addEventListener("htmx:afterSettle", watch);
document.addEventListener("fam-bar-resized", () => {
  observer?.disconnect();
  observer = null;
  watch();
});
back.addEventListener("click", () => {
  if (!today) return;
  window.scrollTo({ top: today.getBoundingClientRect().top + window.scrollY - barHeight() - 16, behavior: "smooth" });
});
`;

/**
 * The part of an Agenda that htmx swaps: on a quick filter change, and every minute, so that a
 * wall tablet keeps its clock and "now" line current. The refresh asks for the days scrolled to,
 * which loading more days keeps up to date, so that it neither drops them nor moves the page.
 */
export function AgendaTimeline(props: { page: AgendaPage }) {
  const { page } = props;
  const { t } = useTranslation();
  return (
    <main
      id="agenda"
      hx-get={agendaUrl(page.id, page.showing)}
      hx-trigger={`every 60s, ${activityEnded} from:body`}
      hx-swap="outerHTML"
      hx-include="#shown-from, #shown-until"
      hx-disinherit="hx-include"
    >
      <ShownDay side="from" date={page.days[0]?.date ?? page.now.date} />
      <ShownDay side="until" date={page.days.at(-1)?.date ?? page.now.date} />
      <AgendaBar page={page} />
      {page.pinned.length > 0 ? (
        <section class="fam-tasks" aria-labelledby="to-do">
          <h2 class="fam-tasks__title" id="to-do">
            {t.agenda.toDo}
          </h2>
          <ul class="fam-tasks__list">
            {page.pinned.map((row) => (
              <TaskRow row={row} members={othersThanSole(page)} tick={<TickForm row={row} page={page} />} />
            ))}
          </ul>
        </section>
      ) : null}
      <ol class="fam-days">
        <AgendaDays page={page} earlier later />
      </ol>
    </main>
  );
}

export function TaskListDocument(props: { page: TaskListPage }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.agenda.taskList.title} surface="agenda" manifest={manifestOf(props.page)}>
      <TaskList page={props.page} />
      <script>{raw(agendaBar)}</script>
    </Layout>
  );
}

/**
 * The part of a Task List that htmx swaps, on a quick filter change, a tick and every minute: its
 * Tasks Due or Overdue, then those not Due yet, then those done, each with its tick.
 */
export function TaskList(props: { page: TaskListPage }) {
  const { page } = props;
  const { t } = useTranslation();
  const l = t.agenda.taskList;
  const section = (id: string, title: string, rows: TimelineTask[], quiet?: boolean) =>
    rows.length > 0 ? (
      <section class={quiet ? "fam-tasks fam-tasks--quiet" : "fam-tasks"} aria-labelledby={id}>
        <h2 class="fam-tasks__title" id={id}>
          {title} <span class="fam-tasks__count">{rows.length}</span>
        </h2>
        <ul class="fam-tasks__list">
          {rows.map((row) => (
            <TaskRow row={row} members={othersThanSole(page)} tick={<TickForm row={row} page={page} />} />
          ))}
        </ul>
      </section>
    ) : null;
  const none = page.due.length + page.upcoming.length + page.done.length === 0;
  return (
    <main id="agenda" hx-get={agendaUrl(page.id, page.showing)} hx-trigger={`every 60s, ${activityEnded} from:body`} hx-swap="outerHTML">
      <AgendaBar page={page} kind={l.title} />
      {none ? (
        <section class="fam-tasks">
          <p class="fam-empty">{l.none}</p>
        </section>
      ) : (
        <>
          {section("to-do", t.agenda.toDo, page.due)}
          {section("coming-up", l.upcoming, page.upcoming)}
          {section("done", l.done, page.done, true)}
        </>
      )}
      <div class="fam-tasks__end"></div>
    </main>
  );
}

/**
 * An Agenda's sticky top bar, whatever its kind: the clock, the Theme switch, its title if it has
 * one, a hint that some of it may be out of date, the quick filter, and, as a line along its bottom
 * edge, what the worker is busy with.
 *
 * On a phone the title, the hint and the filter are rows under the clock, and `agendaBar` folds the
 * bar into one line once the page is scrolled, the filter becoming the avatars of those shown, which
 * unfold it again; the title waits for the top, and the hint shrinks to an icon. A wall tablet and
 * a desktop show the clock, the title and the switch in one row, the hint and a small filter under
 * them.
 */
function AgendaBar(props: { page: AgendaPage | TaskListPage; kind?: string }) {
  const { page } = props;
  const { t, locale } = useTranslation();
  const everyone = showsEveryChoice(page);
  const shown = everyone ? [] : page.choices.filter((member) => page.showing.includes(member.id));
  const sole = soleChoice(page);
  return (
    <header class="fam-bar">
      <div class="fam-bar__inner">
        <div class="fam-clock">
          {page.now.time} <span class="fam-clock__date">{dateLabel(page.now.date, locale)}</span>
        </div>
        {props.kind ? <h1 class="fam-bar__title">{props.kind}</h1> : null}
        {page.mayBeOutOfDate ? (
          <p class="fam-out-of-date" role="status" tabindex={0}>
            <span class="fam-out-of-date__text">{t.agenda.outOfDate}</span>
          </p>
        ) : null}
        {sole ? (
          <p class="fam-bar__member">
            <Avatar member={sole} />
            <span class="fam-bar__member-name">{sole.name}</span>
          </p>
        ) : null}
        {page.choices.length > 1 ? (
          <>
            <button type="button" class="fam-bar__summary" aria-controls="quick-filter" aria-expanded="false" aria-label={t.agenda.quickFilter}>
              <span class="fam-avatars">
                {everyone ? <span class="fam-avatar fam-avatar--all" aria-hidden="true"></span> : shown.map((member) => <Avatar member={member} />)}
              </span>
              <span class="fam-bar__chevron" aria-hidden="true">
                ▾
              </span>
            </button>
            <nav
              id="quick-filter"
              class="fam-filter"
              aria-label={t.agenda.quickFilter}
              hx-boost="true"
              hx-target="#agenda"
              hx-swap="outerHTML swap:250ms"
            >
              <a class="fam-filter__item fam-pillswitch" href={agendaUrl(page.id, "all")} aria-current={everyone ? "true" : undefined} title={t.agenda.all}>
                <span class="fam-avatar fam-avatar--all" aria-hidden="true"></span>
                <span class="fam-pillswitch__name">{t.agenda.all}</span>
              </a>
              {page.choices.map((member) => (
                <a
                  class="fam-filter__item fam-pillswitch"
                  href={agendaUrl(page.id, toggled(page, member.id))}
                  aria-current={!everyone && page.showing.includes(member.id) ? "true" : undefined}
                  title={member.name}
                >
                  <Avatar member={member} />
                  <span class="fam-pillswitch__name">{member.name}</span>
                </a>
              ))}
            </nav>
          </>
        ) : null}
        <ThemeSwitch />
      </div>
      <ActivityIndicator agendaId={page.id} activity={page.activity} />
    </header>
  );
}

/**
 * The button that steps this browser's Theme through the device's, light and dark (`layout.tsx`
 * makes it work). It draws all three icons and the stylesheet shows the one of the current mode.
 */
function ThemeSwitch() {
  const { t } = useTranslation();
  const icon = (mode: string, shapes: Child) => (
    <svg
      class={`fam-theme__icon fam-theme__icon--${mode}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {shapes}
    </svg>
  );
  return (
    <button
      type="button"
      class="fam-theme"
      data-theme-switch
      data-system={t.agenda.theme.system}
      data-light={t.agenda.theme.light}
      data-dark={t.agenda.theme.dark}
      aria-label={t.agenda.theme.system}
      title={t.agenda.theme.system}
    >
      {icon(
        "system",
        <>
          <circle cx="12" cy="12" r="8.5"></circle>
          <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"></path>
        </>,
      )}
      {icon(
        "light",
        <>
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"></path>
        </>,
      )}
      {icon("dark", <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"></path>)}
    </button>
  );
}

/** The event the indicator raises once the worker is done, so that the timeline shows what it brought. */
export const activityEnded = "activity-ended";

/** How often the indicator asks again: often while the worker is busy, rarely while it is idle. */
const activityPolling = { busy: "every 3s", idle: "every 20s" };

/**
 * What the worker is busy with, such as reading messages, with how far it got; empty while it is
 * idle. It asks for itself again, and says while busy that it was, so that the answer once the
 * worker is done can raise `activityEnded`.
 */
export function ActivityIndicator(props: { agendaId: string; activity: CurrentActivity | null }) {
  const { agendaId, activity } = props;
  const { t } = useTranslation();
  const label = activity ? t.agenda.activity[activity.kind] : "";
  return (
    <div
      id="activity"
      class="fam-activity"
      role="status"
      hx-get={`/agendas/${agendaId}/activity`}
      hx-trigger={activity ? activityPolling.busy : activityPolling.idle}
      hx-swap="outerHTML"
      hx-vals={activity ? '{"was":"busy"}' : undefined}
    >
      {activity ? (
        <>
          <span class="fam-visually-hidden">
            {label} {Math.min(activity.done + 1, activity.total)}/{activity.total}
          </span>
          <progress value={activity.done} max={activity.total} aria-label={label}></progress>
        </>
      ) : null}
    </div>
  );
}

/** The first or last day on the page, for the refresh; `oob` when more days loaded replace it. */
export function ShownDay(props: { side: "from" | "until"; date: LocalDate; oob?: boolean }) {
  return (
    <input
      type="hidden"
      id={`shown-${props.side}`}
      name={props.side}
      value={props.date}
      hx-swap-oob={props.oob ? "true" : undefined}
    />
  );
}

/**
 * The days of a page, with a button to load the days before them and, at the end, a marker that
 * loads the days after them once it scrolls into sight; one horizon at a time each.
 */
export function AgendaDays(props: { page: AgendaPage; earlier?: boolean; later?: boolean }) {
  const { page } = props;
  const { t } = useTranslation();
  const first = page.days[0]?.date ?? page.now.date;
  const last = page.days.at(-1)?.date ?? page.now.date;
  const before = { first: addDays(first, -page.horizonDays), last: addDays(first, -1) };
  const after = { first: addDays(last, 1), last: addDays(last, page.horizonDays) };
  return (
    <>
      {props.earlier ? (
        <li class="fam-more">
          <button
            type="button"
            class="fam-button fam-button--secondary fam-button--pill"
            hx-get={daysUrl(page, before, "earlier")}
            hx-target="closest li"
            hx-swap="outerHTML"
          >
            {t.agenda.earlierDays}
          </button>
        </li>
      ) : null}
      {page.days.map((day) => (
        <DayEntry page={page} day={day} />
      ))}
      {props.later ? (
        <li class="fam-more" hx-get={daysUrl(page, after, "later")} hx-trigger="revealed" hx-swap="outerHTML">
          {t.agenda.loadingLaterDays}
        </li>
      ) : null}
    </>
  );
}

function DayEntry(props: { page: AgendaPage; day: TimelineDay }) {
  const { page, day } = props;
  const { t, locale } = useTranslation();
  const relative = t.agenda.relativeDays[String(daysBetween(page.now.date, day.date))];
  const rows = rowsOf(day);
  // What is running is only told on today.
  const now = day.date === page.now.date ? page.now.time : undefined;
  const show = (row: DayRow) =>
    row.kind === "event" ? (
      <EventRow row={row.row} day={day.date} members={othersThanSole(page)} now={now} />
    ) : row.kind === "school" ? (
      <SchoolDayRow row={row.row} members={othersThanSole(page)} now={now} />
    ) : (
      <TimetableChangeRow row={row.row} members={othersThanSole(page)} now={now} />
    );
  return (
    <li class={day.date === page.now.date ? "fam-day fam-day--today" : "fam-day"} data-date={day.date}>
      <h2 class="fam-day__header">
        <span class="fam-day__name">{relative ?? weekdayLabel(day.date, locale)}</span>{" "}
        <span class="fam-day__date">{relative ? dateLabel(day.date, locale) : dayMonthLabel(day.date, locale)}</span>
      </h2>
      {rows.map(show)}
      {day.tasks.length > 0 ? (
        <ul class="fam-tasks__list">
          {day.tasks.map((row) => (
            <TaskRow row={row} members={othersThanSole(page)} tick={<TickForm row={row} page={page} />} onDay />
          ))}
        </ul>
      ) : null}
      {rows.length === 0 && day.tasks.length === 0 ? <p class="fam-empty">{t.agenda.nothingPlanned}</p> : null}
    </li>
  );
}

type DayRow =
  | { kind: "event"; row: TimelineEvent }
  | { kind: "school"; row: TimelineSchoolDay }
  | { kind: "change"; row: TimelineTimetableChange };

/**
 * A day's rows in order of time: all-day Events first, and a school day before the Timetable
 * Changes and Events that start with it.
 */
function rowsOf(day: TimelineDay): DayRow[] {
  const rows: DayRow[] = [
    ...day.schoolDays.map((row) => ({ kind: "school" as const, row })),
    ...day.timetableChanges.map((row) => ({ kind: "change" as const, row })),
    ...day.items.map((row) => ({ kind: "event" as const, row })),
  ];
  const key = (row: DayRow) => (row.kind === "event" ? (row.row.span.allDay ? "" : (row.row.from ?? "00:00")) : row.row.from);
  // A stable sort keeps the Events in the order the timeline gives them.
  return rows.sort((a, b) => key(a).localeCompare(key(b)));
}

/** The dot and "Now" above the time of what is running. */
function RunningMark() {
  const { t } = useTranslation();
  return <span class="fam-running">{t.agenda.running}</span>;
}

/** Whether something from `from` until `until` on today, either null if it goes on past the day, runs at `now`. */
function runsAt(now: string | undefined, from: string | null, until: string | null): boolean {
  return now !== undefined && (from === null || from <= now) && (until === null || now < until);
}

/**
 * The one Family Member an Agenda is for, whom its bar names instead of offering a filter; none for
 * an Agenda for the whole Family, even one of a single member.
 */
function soleChoice(page: { choices: FamilyMemberSummary[]; showing: Showing }): FamilyMemberSummary | undefined {
  const [first, ...rest] = page.choices;
  return rest.length === 0 && page.showing !== "all" ? first : undefined;
}

/** Whom rows show avatars of: in an Agenda for one Family Member, the bar names them, so its rows leave them out. */
function othersThanSole(page: { choices: FamilyMemberSummary[]; showing: Showing; members: FamilyMemberSummary[] }): FamilyMemberSummary[] {
  const sole = soleChoice(page);
  return sole ? page.members.filter((member) => member.id !== sole.id) : page.members;
}

/** The avatars of the Family Members a row concerns, none if it concerns the whole Family. */
function Concerned(props: { concerns: TimelineEvent["concerns"]; members: FamilyMemberSummary[] }) {
  const { concerns } = props;
  const concerned = concerns === "whole-family" ? [] : props.members.filter((member) => concerns.includes(member.id));
  return concerned.length > 0 ? (
    <span class="fam-event__who" aria-label={concerned.map((member) => member.name).join(", ")} role="img">
      <span class="fam-avatars">
        {concerned.map((member) => (
          <Avatar member={member} size="sm" />
        ))}
      </span>
    </span>
  ) : null;
}

/** A school day as one row, "School until hh:mm", that lists its Lessons on tap; today's marks the Lesson running, and the whole row while it is closed. */
function SchoolDayRow(props: { row: TimelineSchoolDay; members: FamilyMemberSummary[]; now: string | undefined }) {
  const { row, now } = props;
  const { t } = useTranslation();
  const v = t.agenda;
  const running = !row.cancelled && runsAt(now, row.from, row.until);
  const classes = [
    "fam-event",
    "fam-event--school",
    row.cancelled ? "fam-event--cancelled" : "",
    row.earlier ? "fam-event--earlier" : "",
    running ? "fam-event--now" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <details class={classes}>
      <summary>
        <span class="fam-event__time">
          {running ? <RunningMark /> : null}
          {row.from}
        </span>
        <span class="fam-event__title">
          {row.cancelled ? (
            <>
              <s>{v.school}</s> <span class="fam-event__tag">{v.cancelled}</span>
            </>
          ) : (
            v.schoolUntil(row.until)
          )}
        </span>
        <Concerned concerns={row.concerns} members={props.members} />
      </summary>
      <ol class="fam-lessons" aria-label={v.lessons}>
        {row.lessons.map((lesson) => {
          const running = !lesson.cancelled && runsAt(now, lesson.from, lesson.until);
          const classes = ["fam-lesson", lesson.cancelled ? "fam-lesson--cancelled" : "", running ? "fam-lesson--now" : ""].filter(Boolean).join(" ");
          return (
            <li class={classes} aria-current={running ? "time" : undefined}>
              <span class="fam-lesson__time">
                {running ? <RunningMark /> : null}
                {lesson.from} – {lesson.until}
              </span>
              <span class="fam-lesson__subject">{lesson.cancelled ? <s>{lesson.subject}</s> : lesson.subject}</span>
              <span class="fam-lesson__where">{[lesson.room, lesson.teacher].filter(Boolean).join(" · ")}</span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** A Timetable Change as its own highlighted row, such as "Physics: cancelled", with what changed on tap. */
function TimetableChangeRow(props: { row: TimelineTimetableChange; members: FamilyMemberSummary[]; now: string | undefined }) {
  const { row } = props;
  const { t } = useTranslation();
  const v = t.agenda;
  const running = row.change !== "cancellation" && runsAt(props.now, row.from, row.until);
  const classes = ["fam-event", "fam-event--change", row.earlier ? "fam-event--earlier" : "", running ? "fam-event--now" : ""]
    .filter(Boolean)
    .join(" ");
  const label = changeLabel({ ...row, note: null }, t);
  return (
    <details class={classes}>
      <summary>
        <span class="fam-event__time">
          {running ? <RunningMark /> : null}
          {row.from} – {row.until}
        </span>
        <span class="fam-event__title">
          <span aria-hidden="true">⚠ </span>
          {row.subject}: {label}
        </span>
        <Concerned concerns={row.concerns} members={props.members} />
      </summary>
      <dl class="fam-event__details">
        <dt>{v.timetableChange}</dt>
        <dd>
          {row.subject}: {label}
        </dd>
        <ChangedValue label={v.where} value={row.room} previous={row.previousRoom} />
        <ChangedValue label={v.teacher} value={row.teacher} previous={row.previousTeacher} onlyChanged />
        <ChangedValue label={v.note} value={row.note} previous={null} />
      </dl>
    </details>
  );
}

/** A detail of a Timetable Change, with what it was instead if that differs; nothing without a value. */
function ChangedValue(props: { label: string; value: string | null; previous: string | null; onlyChanged?: boolean }) {
  const { label, value, previous, onlyChanged } = props;
  const { t } = useTranslation();
  const instead = previous && previous !== value ? ` (${t.agenda.instead(previous)})` : "";
  if (!value || (onlyChanged && !instead)) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value}
        {instead}
      </dd>
    </>
  );
}

/** Whether an Event that is not cancelled, nor all day, is on at `now`, today's time; no Event is on any other day. */
function isRunning(row: TimelineEvent, now: string | undefined): boolean {
  return !row.span.allDay && !row.cancelled && runsAt(now, row.from, row.until);
}

/** The modifier classes of an Event row that is cancelled or over. */
function itemState(row: TimelineEvent): string {
  return [row.cancelled ? "fam-item--cancelled" : "", row.earlier ? "fam-item--earlier" : ""].filter(Boolean).join(" ");
}

/**
 * One Event as a row like a Task's: its time, its title, the avatars of the Family Members it
 * concerns, none if it concerns the whole Family, and below the title its last day if that is
 * a later one, its place and its Sources. The day it is on says its date.
 */
function EventRow(props: { row: TimelineEvent; day: LocalDate; members: FamilyMemberSummary[]; now: string | undefined; action?: Child }) {
  const { row } = props;
  const translation = useTranslation();
  const { t } = translation;
  const v = t.agenda;
  const running = isRunning(row, props.now);
  const classes = ["fam-item", itemState(row), running ? "fam-item--now" : ""].filter(Boolean).join(" ");
  const lastDay = lastDayLabel(row.span, props.day, translation);
  return (
    <div class={classes} aria-current={running ? "time" : undefined}>
      <span class="fam-item__lead">
        {running ? <RunningMark /> : null}
        {timeLabel(row, t)}
      </span>
      <span class="fam-item__text">
        <span class="fam-item__title">
          {row.cancelled ? (
            <>
              <s>{row.title}</s> <span class="fam-event__tag">{v.cancelled}</span>
            </>
          ) : (
            row.title
          )}
        </span>
        {lastDay ? <span class="fam-item__meta">{lastDay}</span> : null}
        {row.place ? <span class="fam-item__meta">{row.place}</span> : null}
        <Sources row={row} />
      </span>
      <Concerned concerns={row.concerns} members={props.members} />
      {props.action}
    </div>
  );
}

/** Where an Event or a Task comes from: its links, and the messages it was read from, which only Admins open. */
function Sources(props: { row: Pick<TimelineEvent, "links" | "messages"> }) {
  const { t, text, locale } = useTranslation();
  return (
    <>
      {props.row.links.map((link) => (
        <span class="fam-item__meta">
          <a href={link.url} rel="noreferrer" target="_blank">
            {text(link.source)}
          </a>
        </span>
      ))}
      {props.row.messages.map((message) => (
        <span class="fam-item__meta">
          {text(message.source)} · {new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(message.sentAt)} · <a href={`/admin/messages/${message.id}`}>{t.agenda.openMessage}</a>
        </span>
      ))}
    </>
  );
}
/**
 * The status label of a Task in the timeline or Task List: done, overdue by its deadline, due
 * with its deadline, or just its deadline or due.
 */
function taskStatusLabel(row: TimelineTask, v: Catalogue["agenda"], deadline: string | null): string {
  if (row.status === "done") return v.done;
  if (row.status === "overdue" && deadline) return v.overdueBy(deadline);
  if (row.status === "due") return [v.due, deadline ? v.by(deadline) : null].filter(Boolean).join(" · ");
  return deadline ? v.by(deadline) : v.due;
}


/**
 * A Task as one row with its tick, the design system's checkbox, which posts once it changes as
 * htmx swaps the timeline or the Task List, and its Deadline and description. A done one is
 * checked and dimmed, and its tick can be taken back. On its day, the tick takes the place of an
 * Event's time, and the row leaves out its Deadline and status, which the day and the tick say.
 */
function TaskRow(props: { row: TimelineTask; members: FamilyMemberSummary[]; tick: Child; onDay?: boolean; action?: Child }) {
  const { row } = props;
  const { t, locale } = useTranslation();
  const v = t.agenda;
  const classes = ["fam-item", "fam-task", `fam-task--${row.status}`, row.cancelled ? "fam-item--cancelled" : ""]
    .filter(Boolean)
    .join(" ");
  const deadline = row.deadline ? dateLabel(row.deadline, locale) : null;
  const status = taskStatusLabel(row, v, deadline);
  return (
    <li class={classes}>
      {props.onDay ? <span class="fam-item__lead">{props.tick}</span> : props.tick}
      {/* A div, not a span, as its description holds paragraphs and a list. */}
      <div class="fam-item__text">
        <span class="fam-item__title">
          {row.cancelled ? (
            <>
              <s>{row.title}</s> <span class="fam-event__tag">{v.cancelled}</span>
            </>
          ) : (
            row.title
          )}
        </span>
        {props.onDay ? null : <span class="fam-item__meta fam-task__status">{status}</span>}
        {row.description === null ? null : <TaskDescription description={row.description} />}
        <Sources row={row} />
      </div>
      <Concerned concerns={row.concerns} members={props.members} />
      {props.action}
    </li>
  );
}

/** A Task's description: its `- ` lines as a list, every other line as a paragraph of its own. */
function TaskDescription(props: { description: string }) {
  return (
    <div class="fam-item__meta fam-task__description">
      {descriptionBlocks(props.description).map((block) =>
        typeof block === "string" ? (
          <p>{block}</p>
        ) : (
          <ul>
            {block.map((entry) => (
              <li>{entry}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** The paragraphs of a description, and its runs of `- ` lines as the entries of a list. */
function descriptionBlocks(description: string): (string | string[])[] {
  const blocks: (string | string[])[] = [];
  for (const line of description.split("\n").map((text) => text.trim()).filter(Boolean)) {
    const last = blocks.at(-1);
    if (!line.startsWith("- ")) blocks.push(line);
    else if (Array.isArray(last)) last.push(line.slice(2).trim());
    else blocks.push([line.slice(2).trim()]);
  }
  return blocks;
}

function TickForm(props: { row: TimelineTask; page: AgendaPage | TaskListPage }) {
  const { row, page } = props;
  const done = row.status === "done";
  const { t } = useTranslation();
  const v = t.agenda;
  const action = `/agendas/${page.id}/tasks/${row.itemId}/${done ? "undone" : "done"}`;
  return (
    <form
      method="post"
      action={action}
      hx-post={action}
      hx-trigger="change"
      hx-target="#agenda"
      hx-swap="outerHTML"
      hx-include={page.layout === "timeline" ? "#shown-from, #shown-until" : undefined}
    >
      <input type="hidden" name="show" value={page.showing === "all" ? "all" : page.showing.join(",")} />
      <label class="fam-task__tick">
        <input type="checkbox" checked={done} aria-label={done ? v.markNotDone(row.title) : v.markDone(row.title)} />
      </label>
    </form>
  );
}

/** How the Event shows on its day: from and until, or all day. */
function timeLabel(row: TimelineEvent, t: Catalogue): string {
  if (row.from && row.until) return row.from === row.until ? row.from : `${row.from} – ${row.until}`;
  if (row.from) return t.agenda.from(row.from);
  if (row.until) return t.agenda.until(row.until);
  return t.agenda.allDay;
}

/**
 * What a Timetable Change did to its Lesson, after the subject: "cancelled", "substituted by Ms
 * Weber" or "moved to room 204", with the school's note if it wrote one.
 */
export function changeLabel(change: TimelineTimetableChange, t: Catalogue): string {
  const { changed } = t.agenda;
  const label =
    change.change === "cancellation"
      ? changed.cancellation
      : change.change === "substitution"
        ? changed.substitution(change.teacher)
        : changed["room-change"](change.room);
  return change.note ? `${label} (${change.note})` : label;
}

/**
 * The last day of an Event that goes on after the given day, "Until Fri 6 Nov", with the time it
 * ends unless it is all day; null if it ends on that day.
 */
function lastDayLabel(span: TimelineEvent["span"], day: LocalDate, { t, locale }: Translation): string | null {
  if (span.allDay) return span.lastDay > day ? t.agenda.untilDay(dateLabel(span.lastDay, locale)) : null;
  return span.end.date > day ? t.agenda.untilDay(`${dateLabel(span.end.date, locale)}, ${span.end.time}`) : null;
}

/** The whole span of an Event, as its calendar feed describes it, in the Translation's language. */
export function spanLabel(span: TimelineEvent["span"], { t, locale }: Translation): string {
  const date = (day: LocalDate) => dateLabel(day, locale);
  if (span.allDay) {
    return span.firstDay === span.lastDay ? t.agenda.onAllDay(date(span.firstDay)) : `${date(span.firstDay)} – ${date(span.lastDay)}`;
  }
  const { start, end } = span;
  return start.date === end.date
    ? `${date(start.date)}, ${start.time} – ${end.time}`
    : `${date(start.date)}, ${start.time} – ${date(end.date)}, ${end.time}`;
}

/** A round avatar: the photo, or the animal or else the initial on one of the eight member colours. */
export function Avatar(props: { member: FamilyMemberSummary; size?: "sm" }) {
  const { member } = props;
  const size = props.size ? ` fam-avatar--${props.size}` : "";
  return member.hasPhoto ? (
    <span class={`fam-avatar${size}`}>
      <img src={`/family-members/${member.id}/photo`} alt="" />
    </span>
  ) : (
    <span class={`fam-avatar${size} fam-avatar--m${member.colour}`} aria-hidden="true">
      {member.avatar ? <img class="fam-avatar__animal" src={avatarUrl(member.avatar)} alt="" /> : member.initial}
    </span>
  );
}

export function agendaUrl(id: string, showing?: Showing): string {
  if (showing === undefined) return `/agendas/${id}`;
  return `/agendas/${id}?show=${showing === "all" ? "all" : showing.join(",")}`;
}

/** Where htmx loads more days of an Agenda, with the marker to go on with on the given side. */
export function daysUrl(page: AgendaPage, days: TimelineDays, then: "earlier" | "later"): string {
  const show = page.showing === "all" ? "all" : page.showing.join(",");
  return `/agendas/${page.id}/days?show=${show}&from=${days.first}&until=${days.last}&then=${then}`;
}

/** Whether the quick filter shows everyone it offers, as "All" does. */
function showsEveryChoice(page: AgendaPage | TaskListPage): boolean {
  const { showing } = page;
  return showing === "all" || page.choices.every((member) => showing.includes(member.id));
}

/** What the quick filter shows after tapping a Family Member: added, or taken out again. */
// eslint-disable-next-line sonarjs/function-return-type -- the filter is either a member list or "all"
function toggled(page: AgendaPage | TaskListPage, id: FamilyMemberId): Showing {
  if (showsEveryChoice(page) || page.showing === "all") return [id];
  const showing = page.showing;
  const next = page.choices
    .map((member) => member.id)
    .filter((memberId) => (memberId === id) !== showing.includes(memberId));
  return next.length > 0 ? next : "all";
}

/** A day further away, as its header names it: "Thursday", or "Donnerstag" in `de-DE`. */
function weekdayLabel(date: LocalDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** The date beside a day's name: "29 Oct", or "29. Okt." in `de-DE`. */
function dayMonthLabel(date: LocalDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function dateLabel(date: LocalDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Which of the eight member colours a Family Member has, stable by id, so that their avatar keeps it. */
/** The tick of a Task on the message page: shown as in an Agenda, but only the Agenda changes it. */
function StaticTick(props: { row: TimelineTask }) {
  return (
    <label class="fam-task__tick">
      <input type="checkbox" checked={props.row.status === "done"} disabled aria-label={props.row.title} />
    </label>
  );
}

/** Takes the Item away from the Agenda; reading the message again would bring it back. */
function DeleteItem(props: { messageId: string; itemId: string; title: string }) {
  const { t } = useTranslation();
  return (
    <form method="post" action={`/admin/items/${props.itemId}/delete`}>
      <input type="hidden" name="message" value={props.messageId} />
      <button type="submit" class="fam-button fam-button--secondary" aria-label={`${t.message.deleteItem}: ${props.title}`}>
        {t.message.deleteItem}
      </button>
    </form>
  );
}

/**
 * The Items read from a raw message as an Agenda shows them, each with a button to delete it: the
 * Events under the days they start on, then the Tasks.
 */
export function MessageItems(props: { messageId: string; items: MessageItemRows }) {
  const { items } = props;
  const { t, locale } = useTranslation();
  const none = items.days.length === 0 && items.tasks.length === 0;
  return (
    <section>
      <h2>{t.message.items}</h2>
      <p class="fam-row__hint">{none ? t.message.noItems : t.message.itemsHint}</p>
      <ol class="fam-days">
        {items.days.map((day) => (
          <li class="fam-day" data-date={day.date}>
            <h2 class="fam-day__header">
              <span class="fam-day__name">{weekdayLabel(day.date, locale)}</span>{" "}
              <span class="fam-day__date">{dayMonthLabel(day.date, locale)}</span>
            </h2>
            {day.items.map((row) => (
              <EventRow
                row={row}
                day={day.date}
                members={items.members}
                now={undefined}
                action={<DeleteItem messageId={props.messageId} itemId={row.itemId} title={row.title} />}
              />
            ))}
          </li>
        ))}
      </ol>
      {items.tasks.length > 0 ? (
        <ul class="fam-tasks__list">
          {items.tasks.map((row) => (
            <TaskRow
              row={row}
              members={items.members}
              tick={<StaticTick row={row} />}
              action={<DeleteItem messageId={props.messageId} itemId={row.itemId} title={row.title} />}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
