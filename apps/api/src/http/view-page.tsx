import type { FamilyMemberSummary, Showing, ViewPage } from "@family-butler/application";
import type { FamilyMemberId, LocalDate } from "@family-butler/domain";
import { Layout } from "./layout";

// The one View layout (ADR-0003): a dark, vertical timeline that works on a phone, a desktop
// and a wall tablet, after variant E of the View prototype.
const viewStyles = `
  :root { color-scheme: dark; font-family: system-ui, sans-serif; --bg: #0f1115; --line: #22262e;
    --muted: #9ca3af; --ink: #f3f4f6; --now: #f87171; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-size: 15px; line-height: 1.4; }
  .bar { position: sticky; top: 0; z-index: 1; background: #0f1115ee; backdrop-filter: blur(6px);
    padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
  .bar > * { max-width: 640px; margin: 0 auto; }
  .clock { font-size: 28px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .clock .date { font-size: 15px; font-weight: 500; color: var(--muted); }
  .filters { display: flex; gap: 14px; margin-top: 10px; overflow-x: auto; }
  .filter { display: flex; flex: none; flex-direction: column; align-items: center; gap: 4px;
    color: var(--muted); font-size: 12px; font-weight: 600; text-decoration: none; }
  .filter .av { width: 48px; height: 48px; font-size: 20px; border: 3px solid transparent; opacity: .45;
    transition: opacity .15s, border-color .15s; }
  .filter[aria-current] { color: var(--ink); }
  .filter[aria-current] .av { border-color: var(--ink); opacity: 1; }
  .filter:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 8px; }
  .av { display: grid; place-items: center; flex: none; border-radius: 50%; overflow: hidden;
    color: #fff; font-weight: 700; background: #475569; }
  .av img { width: 100%; height: 100%; object-fit: cover; }
  .days { list-style: none; max-width: 672px; margin: 0 auto; padding: 0 16px 48px; }
  .day h2 { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 22px 0 6px; }
  .day h2 .date { font-weight: 500; letter-spacing: normal; text-transform: none; }
  .now { display: flex; align-items: center; gap: 8px; color: var(--now); font-size: 12px;
    font-weight: 700; margin: 4px 0; text-transform: uppercase; }
  .now::after { content: ""; flex: 1; height: 2px; background: var(--now); }
  .empty { color: #6b7280; margin: 6px 0; padding: 10px 4px; border-bottom: 1px solid var(--line); }
  @media (min-width: 1000px) {
    body { font-size: 18px; }
    .bar > * { max-width: 820px; }
    .days { max-width: 852px; }
    .clock { font-size: 40px; }
    .filter .av { width: 64px; height: 64px; font-size: 26px; }
    .filter { font-size: 14px; }
  }
`;

export function ViewPageDocument(props: { page: ViewPage }) {
  return (
    <Layout title="View" styles={viewStyles}>
      <ViewTimeline page={props.page} />
    </Layout>
  );
}

/**
 * The part of a View that htmx swaps: on a quick filter change, and every minute, so that a
 * wall tablet keeps its clock and "now" line current.
 */
export function ViewTimeline(props: { page: ViewPage }) {
  const { page } = props;
  const url = viewUrl(page.id, page.showing);
  return (
    <main id="view" hx-get={url} hx-trigger="every 60s" hx-swap="outerHTML">
      <header class="bar">
        <div class="clock">
          {page.now.time} <span class="date">{dateLabel(page.now.date)}</span>
        </div>
        <nav class="filters" aria-label="Quick filter" hx-boost="true" hx-target="#view" hx-swap="outerHTML">
          <a class="filter" href={viewUrl(page.id, "all")} aria-current={page.showing === "all" ? "true" : undefined}>
            <span class="av" aria-hidden="true">
              👪
            </span>
            All
          </a>
          {page.members.map((member) => (
            <a
              class="filter"
              href={viewUrl(page.id, toggled(page, member.id))}
              aria-current={page.showing !== "all" && page.showing.includes(member.id) ? "true" : undefined}
            >
              <Avatar member={member} />
              {member.name}
            </a>
          ))}
        </nav>
      </header>
      <ol class="days">
        {page.days.map((day, index) => (
          <li class="day">
            <h2>
              {index < relativeDays.length ? (
                <>
                  {relativeDays[index]} <span class="date">{dateLabel(day.date)}</span>
                </>
              ) : (
                dateLabel(day.date)
              )}
            </h2>
            {index === 0 ? <div class="now">Now {page.now.time}</div> : null}
            <p class="empty">Nothing planned.</p>
          </li>
        ))}
      </ol>
    </main>
  );
}

/** A round avatar: the photo, or the initial on a colour of its own. */
export function Avatar(props: { member: FamilyMemberSummary }) {
  const { member } = props;
  return member.hasPhoto ? (
    <span class="av">
      <img src={`/family-members/${member.id}/photo`} alt="" />
    </span>
  ) : (
    <span class="av" style={`background: hsl(${hueOf(member.id)} 45% 38%)`} aria-hidden="true">{member.initial}</span>
  );
}

export function viewUrl(id: string, showing?: Showing): string {
  if (showing === undefined) return `/views/${id}`;
  return `/views/${id}?show=${showing === "all" ? "all" : showing.join(",")}`;
}

/** What the quick filter shows after tapping a Family Member: added, or taken out again. */
function toggled(page: ViewPage, id: FamilyMemberId): Showing {
  if (page.showing === "all") return [id];
  const next = page.members
    .map((member) => member.id)
    .filter((memberId) => (memberId === id) !== page.showing.includes(memberId));
  return next.length > 0 ? next : "all";
}

const relativeDays = ["Today", "Tomorrow"];

function dateLabel(date: LocalDate): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** A stable hue per Family Member, so that their avatar keeps its colour. */
function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}
