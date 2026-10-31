import type {
  CurrentActivity,
  FamilyMemberSummary,
  Showing,
  TaskListPage,
  TimelineDays,
  TimelineDay,
  TimelineEvent,
  TimelineSchoolDay,
  TimelineTask,
  TimelineTimetableChange,
  ViewPage,
} from "@family-agenda/application";
import { addDays, daysBetween, type FamilyMemberId, type LocalDate } from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Catalogue } from "./i18n/en";
import { useTranslation, type Translation } from "./i18n/translation";
import { Layout } from "./layout";

// The View layouts (ADR-0003): a vertical timeline, or a Task List, that works on a phone, a
// desktop and a wall tablet, in the Family Agenda design system (`design/design.css`).

export function ViewPageDocument(props: { page: ViewPage }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.view.title} surface="view">
      <ViewTimeline page={props.page} />
      <button type="button" id="back-to-today" class="fam-button fam-button--primary fam-button--pill fam-back-to-today" hidden>
        <span class="fam-back-to-today__arrow" aria-hidden="true">↑</span>
        {t.view.today}
      </button>
      <script>{raw(viewBar + backToToday)}</script>
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
const viewBar = `
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
document.body.addEventListener("htmx:afterSettle", syncSummary);
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
 * The part of a View that htmx swaps: on a quick filter change, and every minute, so that a
 * wall tablet keeps its clock and "now" line current. The refresh asks for the days scrolled to,
 * which loading more days keeps up to date, so that it neither drops them nor moves the page.
 */
export function ViewTimeline(props: { page: ViewPage }) {
  const { page } = props;
  const { t } = useTranslation();
  return (
    <main
      id="view"
      hx-get={viewUrl(page.id, page.showing)}
      hx-trigger={`every 60s, ${activityEnded} from:body`}
      hx-swap="outerHTML"
      hx-include="#shown-from, #shown-until"
      hx-disinherit="hx-include"
    >
      <ShownDay side="from" date={page.days[0]?.date ?? page.now.date} />
      <ShownDay side="until" date={page.days.at(-1)?.date ?? page.now.date} />
      <ViewBar page={page} />
      {page.pinned.length > 0 ? (
        <section class="fam-tasks" aria-labelledby="to-do">
          <h2 class="fam-tasks__title" id="to-do">
            {t.view.toDo}
          </h2>
          <ul class="fam-tasks__list">
            {page.pinned.map((row) => (
              <TaskRow row={row} page={page} />
            ))}
          </ul>
        </section>
      ) : null}
      <ol class="fam-days">
        <ViewDays page={page} earlier later />
      </ol>
    </main>
  );
}

export function TaskListDocument(props: { page: TaskListPage }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.view.taskList.title} surface="view">
      <TaskList page={props.page} />
      <script>{raw(viewBar)}</script>
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
  const l = t.view.taskList;
  const section = (id: string, title: string, rows: TimelineTask[], quiet?: boolean) =>
    rows.length > 0 ? (
      <section class={quiet ? "fam-tasks fam-tasks--quiet" : "fam-tasks"} aria-labelledby={id}>
        <h2 class="fam-tasks__title" id={id}>
          {title} <span class="fam-tasks__count">{rows.length}</span>
        </h2>
        <ul class="fam-tasks__list">
          {rows.map((row) => (
            <TaskRow row={row} page={page} />
          ))}
        </ul>
      </section>
    ) : null;
  const none = page.due.length + page.upcoming.length + page.done.length === 0;
  return (
    <main id="view" hx-get={viewUrl(page.id, page.showing)} hx-trigger={`every 60s, ${activityEnded} from:body`} hx-swap="outerHTML">
      <ViewBar page={page} kind={l.title} />
      {none ? (
        <section class="fam-tasks">
          <p class="fam-empty">{l.none}</p>
        </section>
      ) : (
        <>
          {section("to-do", t.view.toDo, page.due)}
          {section("coming-up", l.upcoming, page.upcoming)}
          {section("done", l.done, page.done, true)}
        </>
      )}
      <div class="fam-tasks__end"></div>
    </main>
  );
}

/**
 * A View's sticky top bar, whatever its kind: the clock, the quick filter, a hint that some of it
 * may be out of date, and, as a line along its bottom edge, what the worker is busy with.
 *
 * On a phone the filter is a row of pills under the clock, and `viewBar` folds the bar into one
 * line once the page is scrolled, the filter becoming the avatars of those shown, which unfold it
 * again. A wall tablet and a desktop have room for all of it in one row.
 */
function ViewBar(props: { page: ViewPage | TaskListPage; kind?: string }) {
  const { page } = props;
  const { t, locale } = useTranslation();
  const everyone = showsEveryChoice(page);
  const shown = everyone ? [] : page.choices.filter((member) => page.showing.includes(member.id));
  return (
    <header class="fam-bar">
      <div class="fam-bar__inner">
        <div class="fam-clock">
          {page.now.time} <span class="fam-clock__date">{dateLabel(page.now.date, locale)}</span>
        </div>
        <div class="fam-bar__notes">
          {props.kind ? <span class="fam-bar__kind">{props.kind}</span> : null}
          {page.mayBeOutOfDate ? (
            <p class="fam-out-of-date" role="status" tabindex={0}>
              <span class="fam-out-of-date__text">{t.view.outOfDate}</span>
            </p>
          ) : null}
        </div>
        {page.choices.length > 1 ? (
          <>
            <button type="button" class="fam-bar__summary" aria-controls="quick-filter" aria-expanded="false" aria-label={t.view.quickFilter}>
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
              aria-label={t.view.quickFilter}
              hx-boost="true"
              hx-target="#view"
              hx-swap="outerHTML"
            >
              <a class="fam-filter__item" href={viewUrl(page.id, "all")} aria-current={everyone ? "true" : undefined}>
                <span class="fam-avatar fam-avatar--all" aria-hidden="true"></span>
                {t.view.all}
              </a>
              {page.choices.map((member) => (
                <a
                  class="fam-filter__item"
                  href={viewUrl(page.id, toggled(page, member.id))}
                  aria-current={!everyone && page.showing.includes(member.id) ? "true" : undefined}
                >
                  <Avatar member={member} />
                  {member.name}
                </a>
              ))}
            </nav>
          </>
        ) : null}
        <ThemeSwitch />
      </div>
      <ActivityIndicator viewId={page.id} activity={page.activity} />
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
      data-system={t.view.theme.system}
      data-light={t.view.theme.light}
      data-dark={t.view.theme.dark}
      aria-label={t.view.theme.system}
      title={t.view.theme.system}
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
export function ActivityIndicator(props: { viewId: string; activity: CurrentActivity | null }) {
  const { viewId, activity } = props;
  const { t } = useTranslation();
  const label = activity ? t.view.activity[activity.kind] : "";
  return (
    <div
      id="activity"
      class="fam-activity"
      role="status"
      hx-get={`/views/${viewId}/activity`}
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
export function ViewDays(props: { page: ViewPage; earlier?: boolean; later?: boolean }) {
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
            {t.view.earlierDays}
          </button>
        </li>
      ) : null}
      {page.days.map((day) => (
        <DayEntry page={page} day={day} />
      ))}
      {props.later ? (
        <li class="fam-more" hx-get={daysUrl(page, after, "later")} hx-trigger="revealed" hx-swap="outerHTML">
          {t.view.loadingLaterDays}
        </li>
      ) : null}
    </>
  );
}

function DayEntry(props: { page: ViewPage; day: TimelineDay }) {
  const { page, day } = props;
  const { t, locale } = useTranslation();
  const relative = t.view.relativeDays[String(daysBetween(page.now.date, day.date))];
  const rows = rowsOf(day);
  const show = (row: DayRow) =>
    row.kind === "event" ? (
      <EventRow row={row.row} day={day.date} members={page.members} />
    ) : row.kind === "school" ? (
      <SchoolDayRow row={row.row} members={page.members} />
    ) : (
      <TimetableChangeRow row={row.row} members={page.members} />
    );
  return (
    <li class={day.date === page.now.date ? "fam-day fam-day--today" : "fam-day"} data-date={day.date}>
      <h2 class="fam-day__header">
        <span class="fam-day__name">{relative ?? weekdayLabel(day.date, locale)}</span>{" "}
        <span class="fam-day__date">{relative ? dateLabel(day.date, locale) : dayMonthLabel(day.date, locale)}</span>
      </h2>
      {day.date === page.now.date ? (
        <>
          {rows.filter((row) => row.row.earlier).map(show)}
          <div class="fam-now">{t.view.now(page.now.time)}</div>
          {rows.filter((row) => !row.row.earlier).map(show)}
        </>
      ) : (
        rows.map(show)
      )}
      {day.tasks.length > 0 ? (
        <ul class="fam-tasks__list">
          {day.tasks.map((row) => (
            <TaskRow row={row} page={page} onDay />
          ))}
        </ul>
      ) : null}
      {rows.length === 0 && day.tasks.length === 0 ? <p class="fam-empty">{t.view.nothingPlanned}</p> : null}
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

/** A school day as one row, "School until hh:mm", that lists its Lessons on tap. */
function SchoolDayRow(props: { row: TimelineSchoolDay; members: FamilyMemberSummary[] }) {
  const { row } = props;
  const { t } = useTranslation();
  const v = t.view;
  const classes = ["fam-event", row.cancelled ? "fam-event--cancelled" : "", row.earlier ? "fam-event--earlier" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <details class={classes}>
      <summary>
        <span class="fam-event__time">{row.from}</span>
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
        {row.lessons.map((lesson) => (
          <li class={lesson.cancelled ? "fam-lesson fam-lesson--cancelled" : "fam-lesson"}>
            <span class="fam-lesson__time">
              {lesson.from} – {lesson.until}
            </span>
            <span class="fam-lesson__subject">{lesson.cancelled ? <s>{lesson.subject}</s> : lesson.subject}</span>
            <span class="fam-lesson__where">{[lesson.room, lesson.teacher].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** A Timetable Change as its own highlighted row, such as "Physics: cancelled", with what changed on tap. */
function TimetableChangeRow(props: { row: TimelineTimetableChange; members: FamilyMemberSummary[] }) {
  const { row } = props;
  const { t } = useTranslation();
  const v = t.view;
  const classes = ["fam-event", "fam-event--change", row.earlier ? "fam-event--earlier" : ""].filter(Boolean).join(" ");
  const label = changeLabel({ ...row, note: null }, t);
  return (
    <details class={classes}>
      <summary>
        <span class="fam-event__time">
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
        {row.room ? (
          <>
            <dt>{v.where}</dt>
            <dd>
              {row.room}
              {row.previousRoom && row.previousRoom !== row.room ? ` (${v.instead(row.previousRoom)})` : ""}
            </dd>
          </>
        ) : null}
        {row.teacher && row.previousTeacher && row.previousTeacher !== row.teacher ? (
          <>
            <dt>{v.teacher}</dt>
            <dd>
              {row.teacher} ({v.instead(row.previousTeacher)})
            </dd>
          </>
        ) : null}
        {row.note ? (
          <>
            <dt>{v.note}</dt>
            <dd>{row.note}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

/**
 * One Event as a row like a Task's: its time, its title, the avatars of the Family Members it
 * concerns, none if it concerns the whole Family, and below the title its last day if that is
 * a later one, its place and its Sources. The day it is on says its date.
 */
function EventRow(props: { row: TimelineEvent; day: LocalDate; members: FamilyMemberSummary[] }) {
  const { row } = props;
  const translation = useTranslation();
  const { t } = translation;
  const v = t.view;
  const classes = ["fam-item", row.cancelled ? "fam-item--cancelled" : "", row.earlier ? "fam-item--earlier" : ""]
    .filter(Boolean)
    .join(" ");
  const lastDay = lastDayLabel(row.span, props.day, translation);
  return (
    <div class={classes}>
      <span class="fam-item__lead">{timeLabel(row, t)}</span>
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
    </div>
  );
}

/** Where an Event or a Task comes from: its links, and the messages it was read from, which only Admins open. */
function Sources(props: { row: Pick<TimelineEvent, "links" | "messages"> }) {
  const { t, text } = useTranslation();
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
          {text(message.source)} · <a href={`/admin/messages/${message.id}`}>{t.view.openMessage}</a>
        </span>
      ))}
    </>
  );
}

/**
 * A Task as one row with its tick, the design system's checkbox, which posts once it changes as
 * htmx swaps the timeline or the Task List, and its Deadline and things to bring. A done one is
 * checked and dimmed, and its tick can be taken back. On its day, the tick takes the place of an
 * Event's time, and the row leaves out its Deadline and status, which the day and the tick say.
 */
function TaskRow(props: { row: TimelineTask; page: ViewPage | TaskListPage; onDay?: boolean }) {
  const { row, page } = props;
  const { t, locale } = useTranslation();
  const v = t.view;
  const done = row.status === "done";
  const action = `/views/${page.id}/tasks/${row.itemId}/${done ? "undone" : "done"}`;
  const classes = ["fam-item", "fam-task", `fam-task--${row.status}`, row.cancelled ? "fam-item--cancelled" : ""]
    .filter(Boolean)
    .join(" ");
  const deadline = row.deadline ? dateLabel(row.deadline, locale) : null;
  const status =
    row.status === "done"
      ? v.done
      : row.status === "overdue" && deadline
        ? v.overdueBy(deadline)
        : row.status === "due"
          ? [v.due, deadline ? v.by(deadline) : null].filter(Boolean).join(" · ")
          : deadline
            ? v.by(deadline)
            : v.due;
  const tick = (
    <form
      method="post"
      action={action}
      hx-post={action}
      hx-trigger="change"
      hx-target="#view"
      hx-swap="outerHTML"
      hx-include={page.kind === "timeline" ? "#shown-from, #shown-until" : undefined}
    >
      <input type="hidden" name="show" value={page.showing === "all" ? "all" : page.showing.join(",")} />
      <label class="fam-task__tick">
        <input type="checkbox" checked={done} aria-label={done ? v.markNotDone(row.title) : v.markDone(row.title)} />
      </label>
    </form>
  );
  return (
    <li class={classes}>
      {props.onDay ? <span class="fam-item__lead">{tick}</span> : tick}
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
        {props.onDay ? null : <span class="fam-item__meta fam-task__status">{status}</span>}
        {row.bring.length > 0 ? (
          <span class="fam-item__meta">
            {v.bring}: {row.bring.join(", ")}
          </span>
        ) : null}
        <Sources row={row} />
      </span>
      <Concerned concerns={row.concerns} members={page.members} />
    </li>
  );
}

/** How the Event shows on its day: from and until, or all day. */
function timeLabel(row: TimelineEvent, t: Catalogue): string {
  if (row.from && row.until) return row.from === row.until ? row.from : `${row.from} – ${row.until}`;
  if (row.from) return t.view.from(row.from);
  if (row.until) return t.view.until(row.until);
  return t.view.allDay;
}

/**
 * What a Timetable Change did to its Lesson, after the subject: "cancelled", "substituted by Ms
 * Weber" or "moved to room 204", with the school's note if it wrote one.
 */
export function changeLabel(change: TimelineTimetableChange, t: Catalogue): string {
  const { changed } = t.view;
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
  if (span.allDay) return span.lastDay > day ? t.view.untilDay(dateLabel(span.lastDay, locale)) : null;
  return span.end.date > day ? t.view.untilDay(`${dateLabel(span.end.date, locale)}, ${span.end.time}`) : null;
}

/** The whole span of an Event, as its calendar feed describes it, in the Translation's language. */
export function spanLabel(span: TimelineEvent["span"], { t, locale }: Translation): string {
  const date = (day: LocalDate) => dateLabel(day, locale);
  if (span.allDay) {
    return span.firstDay === span.lastDay ? t.view.onAllDay(date(span.firstDay)) : `${date(span.firstDay)} – ${date(span.lastDay)}`;
  }
  const { start, end } = span;
  return start.date === end.date
    ? `${date(start.date)}, ${start.time} – ${end.time}`
    : `${date(start.date)}, ${start.time} – ${date(end.date)}, ${end.time}`;
}

/** A round avatar: the photo, or the initial on one of the eight member colours. */
export function Avatar(props: { member: FamilyMemberSummary; size?: "sm" }) {
  const { member } = props;
  const size = props.size ? ` fam-avatar--${props.size}` : "";
  return member.hasPhoto ? (
    <span class={`fam-avatar${size}`}>
      <img src={`/family-members/${member.id}/photo`} alt="" />
    </span>
  ) : (
    <span class={`fam-avatar${size} fam-avatar--m${memberColourOf(member.id)}`} aria-hidden="true">
      {member.initial}
    </span>
  );
}

export function viewUrl(id: string, showing?: Showing): string {
  if (showing === undefined) return `/views/${id}`;
  return `/views/${id}?show=${showing === "all" ? "all" : showing.join(",")}`;
}

/** Where htmx loads more days of a View, with the marker to go on with on the given side. */
export function daysUrl(page: ViewPage, days: TimelineDays, then: "earlier" | "later"): string {
  const show = page.showing === "all" ? "all" : page.showing.join(",");
  return `/views/${page.id}/days?show=${show}&from=${days.first}&until=${days.last}&then=${then}`;
}

/** Whether the quick filter shows everyone it offers, as "All" does. */
function showsEveryChoice(page: ViewPage | TaskListPage): boolean {
  const { showing } = page;
  return showing === "all" || page.choices.every((member) => showing.includes(member.id));
}

/** What the quick filter shows after tapping a Family Member: added, or taken out again. */
function toggled(page: ViewPage | TaskListPage, id: FamilyMemberId): Showing {
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
function memberColourOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 8;
  return hash + 1;
}
