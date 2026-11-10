import { iconUrl } from "./design/icons.js";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { editGuards, lazyFragmentErrors } from "./lazy-fragment";
import { useTranslation } from "./i18n/translation";

/**
 * Opens a dialog the server rendered open as a modal one, so that the page behind it is inert
 * and Escape closes it, by going back to the address in its `data-close`. Without JavaScript the
 * dialog still shows, over the page. A link opening a dialog on its own (`data-opens-dialog`)
 * shows a loading dialog with that text at once, which the dialog replaces once loaded; if it
 * cannot be loaded, the link is followed as a plain one, opening the page with the dialog.
 */
const modalDialogs = `
// Known in memory only, so that a dialog restored from htmx's history is opened again.
const modals = new WeakSet();
const openModal = (dialog) => {
  if (modals.has(dialog)) return;
  modals.add(dialog);
  dialog.close();
  dialog.showModal();
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    location.href = dialog.dataset.close;
  });
};
for (const dialog of document.querySelectorAll("dialog.fam-dialog[open]")) openModal(dialog);
document.body.addEventListener("htmx:afterSwap", (event) => {
  for (const dialog of event.detail.target.querySelectorAll("dialog.fam-dialog[open]")) openModal(dialog);
});
document.body.addEventListener("htmx:beforeRequest", (event) => {
  const link = event.detail.elt;
  if (!(link instanceof HTMLElement) || !link.matches("[data-opens-dialog]")) return;
  const loading = document.createElement("dialog");
  loading.className = "fam-dialog";
  loading.setAttribute("aria-busy", "true");
  loading.dataset.close = location.href;
  const spinner = document.createElement("span");
  spinner.className = "fam-spinner";
  spinner.setAttribute("aria-hidden", "true");
  loading.append(spinner, " " + link.dataset.opensDialog);
  document.getElementById("fam-dialog-slot").replaceChildren(loading);
  loading.setAttribute("open", "");
  openModal(loading);
});
// A dialog, loading or loaded on its own, stays out of the page htmx keeps for going Back.
document.body.addEventListener("htmx:beforeHistorySave", () => {
  document.getElementById("fam-dialog-slot")?.replaceChildren();
});
for (const name of ["htmx:responseError", "htmx:sendError"]) {
  document.body.addEventListener(name, (event) => {
    const link = event.detail.elt;
    if (link instanceof HTMLAnchorElement && link.matches("[data-opens-dialog]")) location.href = link.href;
  });
}
`;

/**
 * Copies the `data-copy` text of a button to the clipboard and, for a moment, marks the button
 * `data-done` and labels it with its `data-copied`. Over plain HTTP, as on the home network, `navigator.clipboard` does not exist, so the
 * text is selected in a temporary field and copied the old way.
 */
const copyButtons = `
for (const button of document.querySelectorAll("button[data-copy]")) {
  const label = button.getAttribute("aria-label");
  button.addEventListener("click", async () => {
    const text = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = document.createElement("textarea");
      field.value = text;
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    button.dataset.done = "";
    button.setAttribute("aria-label", button.dataset.copied);
    button.title = button.dataset.copied;
    setTimeout(() => {
      delete button.dataset.done;
      button.setAttribute("aria-label", label);
      button.title = label;
    }, 1500);
  });
}
`;

/**
 * The Theme of this browser: `light`, `dark`, or none to follow the device. It is read before the
 * first paint, so that a dark page does not flash light, and kept in `localStorage` only; the
 * Instance does not know it. `data-theme` fixes the tokens (`tokens.css`); `data-theme-mode` names
 * the choice for the switches; it is missing while the device decides.
 */
const themeBoot = `
document.documentElement.dataset.scripted = "";
try {
  const theme = localStorage.getItem("fam-theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = theme;
  }
} catch {}
`;

/**
 * Makes the Theme switches work: a `[data-theme-switch]` button steps through system, light and
 * dark, a `select[data-theme-select]` picks one. The button's `data-system`, `data-light` and
 * `data-dark` hold its label for each mode. They listen on the document, because htmx swaps the
 * parts of an Agenda that hold them.
 */
const themeSwitches = `
const modes = ["system", "light", "dark"];
const root = document.documentElement;
const currentTheme = () => root.dataset.themeMode ?? "system";
const syncThemeSwitches = () => {
  const mode = currentTheme();
  for (const button of document.querySelectorAll("[data-theme-switch]")) {
    const label = button.dataset[mode];
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  for (const select of document.querySelectorAll("select[data-theme-select]")) select.value = mode;
};
const chooseTheme = (mode) => {
  try {
    if (mode === "system") localStorage.removeItem("fam-theme");
    else localStorage.setItem("fam-theme", mode);
  } catch {}
  if (mode === "system") delete root.dataset.theme;
  else root.dataset.theme = mode;
  root.dataset.themeMode = mode;
  syncThemeSwitches();
};
document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-theme-switch]")) return;
  chooseTheme(modes[(modes.indexOf(currentTheme()) + 1) % modes.length]);
});
document.addEventListener("change", (event) => {
  if (event.target.matches("select[data-theme-select]") && modes.includes(event.target.value)) chooseTheme(event.target.value);
});
document.body.addEventListener("htmx:afterSettle", syncThemeSwitches);
syncThemeSwitches();
`;

/**
 * A page in the Family Agenda design system: its tokens and component classes come from
 * `/static/tokens.css` and `/static/design.css` (`design/`). An Agenda is the Family's timeline; every
 * other page belongs to the Admin area, `narrow` for signing in.
 */
export function Layout(props: {
  title: string;
  surface?: "agenda" | "admin";
  narrow?: boolean;
  /** Where the web app manifest of an Agenda is, so that it can be put on a home screen. */
  manifest?: string;
  children: Child;
}) {
  const agenda = props.surface === "agenda";
  const { language } = useTranslation();
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang={language}>
        <head>
          <meta charset="utf-8" />
          {/* An Agenda fills the screen of an installed app, notch included; its bar pads for the safe area. */}
          <meta name="viewport" content={agenda ? "width=device-width, initial-scale=1, viewport-fit=cover" : "width=device-width, initial-scale=1"} />
          <meta name="color-scheme" content="light dark" />
          {props.manifest ? (
            <>
              <link rel="manifest" href={props.manifest} />
              <meta name="theme-color" content="#faf6f0" media="(prefers-color-scheme: light)" />
              <meta name="theme-color" content="#1c1814" media="(prefers-color-scheme: dark)" />
              <meta name="apple-mobile-web-app-capable" content="yes" />
              <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
              <link rel="apple-touch-icon" href={iconUrl("apple-touch-icon.png")} />
            </>
          ) : null}
          <script>{raw(themeBoot)}</script>
          <title>{props.title} · Family Agenda</title>
          <link rel="stylesheet" href="/static/tokens.css" />
          <link rel="stylesheet" href="/static/design.css" />
          <script src="/static/htmx.min.js" defer></script>
        </head>
        <body class={agenda ? "fam-page fam-agenda" : "fam-page"}>
          {agenda ? (
            props.children
          ) : (
            <div class={props.narrow ? "fam-admin fam-admin--narrow" : "fam-admin"}>{props.children}</div>
          )}
          <script>{raw(agenda ? themeSwitches : modalDialogs + copyButtons + themeSwitches + lazyFragmentErrors + editGuards)}</script>
        </body>
      </html>
    </>
  );
}

export function Problem(props: { message: string | undefined }) {
  return props.message ? <p class="fam-problem">{props.message}</p> : null;
}
