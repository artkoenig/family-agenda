import type { Child } from "hono/jsx";
import { useTranslation } from "./i18n/translation";

/** How a fragment that is not ready yet asks again: after `every` seconds, each wait `backoff` times longer, for up to `maxSeconds`. */
export type FragmentPoll = { every: number; backoff: number; maxSeconds: number };

/**
 * Part of a page loaded right after it, such as what a plugin offers, so that the page does not wait
 * for it: `href` answers with the content, or with `FragmentError` explaining why there is none.
 * `children` stand in meanwhile; without them a spinner with a default text. A failed request
 * becomes an error too (`lazyFragmentErrors`), so that loading never stops silently. `delaySeconds`
 * is how long it waits before asking, as `notReadyYet` sets it. `block` makes it a `div`, for one
 * standing in for a section, whose placeholder may hold block content.
 */
export function LazyFragment(props: { href: string; children?: Child; delaySeconds?: number; block?: boolean }) {
  const { t } = useTranslation();
  const trigger = props.delaySeconds ? `load delay:${props.delaySeconds}s` : "load";
  const Tag = props.block ? "div" : "span";
  return (
    <Tag
      class="fam-lazy"
      hx-get={props.href}
      hx-trigger={trigger}
      hx-swap="outerHTML"
      aria-busy="true"
      aria-live="polite"
      data-failed={t.loading.failed}
      data-failed-message={t.loading.failedMessage}
      data-gone={t.loading.gone}
    >
      {props.children ?? (
        <>
          <span class="fam-spinner" aria-hidden="true"></span> {t.loading.default}
        </>
      )}
    </Tag>
  );
}

/** Why a fragment has no content, in words an Admin understands. No retry button: the next page load asks again. */
export function FragmentError(props: { title: string; message: string | null }) {
  return (
    <span class="fam-lazy fam-lazy--failed" role="alert">
      <strong>{props.title}</strong>
      {props.message !== null ? <> {props.message}</> : null}
    </span>
  );
}

/**
 * What a fragment's endpoint answers while its content is not ready yet, after `waitedSeconds`: the
 * same fragment asking again a little later, each wait `backoff` times the last, until `maxSeconds`
 * have passed and a hint says so.
 */
export function notReadyYet(props: { href: string; poll: FragmentPoll; waitedSeconds: number; children?: Child }) {
  const { href, poll, waitedSeconds } = props;
  if (waitedSeconds >= poll.maxSeconds) return <SlowFragment />;
  // The waits so far add up to `waitedSeconds`; the next is `backoff` times the last.
  const delaySeconds = Math.round((poll.every + waitedSeconds * (poll.backoff - 1)) * 10) / 10;
  const next = `${href}${href.includes("?") ? "&" : "?"}waited=${waitedSeconds + delaySeconds}`;
  return (
    <LazyFragment href={next} delaySeconds={delaySeconds}>
      {props.children}
    </LazyFragment>
  );
}

function SlowFragment() {
  const { t } = useTranslation();
  return <FragmentError title={t.loading.slow} message={null} />;
}

/**
 * Turns a fragment whose request failed, or could not be sent, into an error in its place, with the
 * words the fragment carries, so that its spinner does not turn forever: that what it shows is gone
 * for a 4xx answer, that the server could not be reached otherwise.
 */
export const lazyFragmentErrors = `
for (const name of ["htmx:responseError", "htmx:sendError"]) {
  document.body.addEventListener(name, (event) => {
    const pending = event.detail.elt;
    if (!(pending instanceof HTMLElement) || !pending.matches(".fam-lazy[aria-busy]")) return;
    const failed = document.createElement("span");
    failed.className = "fam-lazy fam-lazy--failed";
    failed.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = pending.dataset.failed || "";
    // A 4xx answer, such as 404 for a Source removed meanwhile, is not a connection problem.
    const status = event.detail.xhr ? event.detail.xhr.status : 0;
    const message = status >= 400 && status < 500 ? pending.dataset.gone : pending.dataset.failedMessage;
    failed.append(title, " " + (message || ""));
    pending.replaceWith(failed);
  });
}
`;
