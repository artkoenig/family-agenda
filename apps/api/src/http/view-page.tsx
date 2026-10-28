import type {
  CurrentActivity,
  FamilyMemberSummary,
  Showing,
  TimelineDays,
  TimelineEvent,
  ViewPage,
} from "@family-agenda/application";
import { addDays, daysBetween, type FamilyMemberId, type LocalDate } from "@family-agenda/domain";
import { raw } from "hono/html";
import type { Catalogue } from "./i18n/en";
import { useTranslation, type Translation } from "./i18n/translation";
import { Layout } from "./layout";

// The one View layout (ADR-0003): a vertical timeline that works on a phone, a desktop and a wall
// tablet, in the Family Agenda design system (`design/design.css`).

export function ViewPageDocument(props: { page: ViewPage }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.view.title} surface="view">
      <ViewTimeline page={props.page} />
      <button type="button" id="back-to-today" class="fam-button fam-button--primary fam-button--pill fam-back-to-today" hidden>
        <span class="fam-back-to-today__arrow" aria-hidden="true">↑</span>
        {t.view.today}
      </button>
      <script>{raw(backToToday)}</script>
    </Layout>
  );
}

/**
 * Shows the button back to today while today is scrolled out of sight, below the top bar, with an
 * arrow towards it. It sits outside the part htmx swaps, and watches today again after each swap,
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
  const { t, locale } = useTranslation();
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
      <header class="fam-bar">
        <div class="fam-bar__top">
          <div class="fam-clock">
            {page.now.time} <span class="fam-clock__date">{dateLabel(page.now.date, locale)}</span>
          </div>
          <ActivityIndicator viewId={page.id} activity={page.activity} />
        </div>
        {page.mayBeOutOfDate ? (
          <p class="fam-out-of-date" role="status">
            {t.view.outOfDate}
          </p>
        ) : null}
        <nav class="fam-filter" aria-label={t.view.quickFilter} hx-boost="true" hx-target="#view" hx-swap="outerHTML">
          <a class="fam-filter__item" href={viewUrl(page.id, "all")} aria-current={page.showing === "all" ? "true" : undefined}>
            <span class="fam-avatar fam-avatar--all" aria-hidden="true"></span>
            {t.view.all}
          </a>
          {page.members.map((member) => (
            <a
              class="fam-filter__item"
              href={viewUrl(page.id, toggled(page, member.id))}
              aria-current={page.showing !== "all" && page.showing.includes(member.id) ? "true" : undefined}
            >
              <Avatar member={member} />
              {member.name}
            </a>
          ))}
        </nav>
      </header>
      <ol class="fam-days">
        <ViewDays page={page} earlier later />
      </ol>
    </main>
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
          <span class="fam-activity__spinner" aria-hidden="true"></span>
          <span>
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

function DayEntry(props: { page: ViewPage; day: ViewPage["days"][number] }) {
  const { page, day } = props;
  const { t, locale } = useTranslation();
  const relative = t.view.relativeDays[String(daysBetween(page.now.date, day.date))];
  return (
    <li class={day.date === page.now.date ? "fam-day fam-day--today" : "fam-day"} data-date={day.date}>
      <h2 class="fam-day__header">
        <span class="fam-day__name">{relative ?? weekdayLabel(day.date, locale)}</span>{" "}
        <span class="fam-day__date">{relative ? dateLabel(day.date, locale) : dayMonthLabel(day.date, locale)}</span>
      </h2>
      {day.date === page.now.date ? (
        <>
          {day.items.filter((row) => row.earlier).map((row) => <EventRow row={row} members={page.members} />)}
          <div class="fam-now">{t.view.now(page.now.time)}</div>
          {day.items.filter((row) => !row.earlier).map((row) => <EventRow row={row} members={page.members} />)}
        </>
      ) : (
        day.items.map((row) => <EventRow row={row} members={page.members} />)
      )}
      {day.items.length === 0 ? <p class="fam-empty">{t.view.nothingPlanned}</p> : null}
    </li>
  );
}

/**
 * One Event as a compact row of time, title and the avatars of the Family Members it concerns,
 * none if it concerns the whole Family, with its details on tap.
 */
function EventRow(props: { row: TimelineEvent; members: FamilyMemberSummary[] }) {
  const { row } = props;
  const concerned = row.concerns === "whole-family" ? [] : props.members.filter((member) => row.concerns.includes(member.id));
  const translation = useTranslation();
  const { t } = translation;
  const v = t.view;
  const classes = ["fam-event", row.cancelled ? "fam-event--cancelled" : "", row.earlier ? "fam-event--earlier" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <details class={classes}>
      <summary>
        <span class="fam-event__time">{timeLabel(row, t)}</span>
        <span class="fam-event__title">
          {row.cancelled ? (
            <>
              <s>{row.title}</s> <span class="fam-event__tag">{v.cancelled}</span>
            </>
          ) : (
            row.title
          )}
        </span>
        {concerned.length > 0 ? (
          <span class="fam-event__who" aria-label={concerned.map((member) => member.name).join(", ")} role="img">
            <span class="fam-avatars">
              {concerned.map((member) => (
                <Avatar member={member} size="sm" />
              ))}
            </span>
          </span>
        ) : null}
      </summary>
      <dl class="fam-event__details">
        <dt>{v.when}</dt>
        <dd>{spanLabel(row.span, translation)}</dd>
        {row.place ? (
          <>
            <dt>{v.where}</dt>
            <dd>{row.place}</dd>
          </>
        ) : null}
        {row.cancelled ? (
          <>
            <dt>{v.status}</dt>
            <dd>{v.cancelled}</dd>
          </>
        ) : null}
        {row.links.map((link) => (
          <>
            <dt>{v.original}</dt>
            <dd>
              <a href={link} rel="noreferrer" target="_blank">
                {v.openOriginal}
              </a>
            </dd>
          </>
        ))}
        {row.messages.map((id) => (
          <>
            <dt>{v.original}</dt>
            <dd>
              <a href={`/admin/messages/${id}`}>{v.openMessage}</a>
              {v.adminsOnly}
            </dd>
          </>
        ))}
      </dl>
    </details>
  );
}

/** How the Event shows on its day: from and until, or all day. */
function timeLabel(row: TimelineEvent, t: Catalogue): string {
  if (row.from && row.until) return row.from === row.until ? row.from : `${row.from} – ${row.until}`;
  if (row.from) return t.view.from(row.from);
  if (row.until) return t.view.until(row.until);
  return t.view.allDay;
}

/** The whole span of an Event, as its details show it, in the Translation's language. */
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
export function Avatar(props: { member: FamilyMemberSummary; size?: "sm" | "lg" }) {
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

/** What the quick filter shows after tapping a Family Member: added, or taken out again. */
function toggled(page: ViewPage, id: FamilyMemberId): Showing {
  if (page.showing === "all") return [id];
  const next = page.members
    .map((member) => member.id)
    .filter((memberId) => (memberId === id) !== page.showing.includes(memberId));
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

function dateLabel(date: LocalDate, locale: string): string {
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
