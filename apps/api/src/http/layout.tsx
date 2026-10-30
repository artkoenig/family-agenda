import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { useTranslation } from "./i18n/translation";

/**
 * Opens a dialog the server rendered open as a modal one, so that the page behind it is inert
 * and Escape closes it, by going back to the address in its `data-close`. Without JavaScript the
 * dialog still shows, over the page.
 */
const modalDialogs = `
for (const dialog of document.querySelectorAll("dialog.fam-dialog[open]")) {
  dialog.close();
  dialog.showModal();
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    location.href = dialog.dataset.close;
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
 * A page in the Family Agenda design system: its tokens and component classes come from
 * `/static/tokens.css` and `/static/design.css` (`design/`). A View is the Family's timeline; every
 * other page belongs to the Admin area, `narrow` for signing in.
 */
export function Layout(props: { title: string; surface?: "view" | "admin"; narrow?: boolean; children: Child }) {
  const view = props.surface === "view";
  const { language } = useTranslation();
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang={language}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{props.title} · Family Agenda</title>
          <link rel="stylesheet" href="/static/tokens.css" />
          <link rel="stylesheet" href="/static/design.css" />
          <script src="/static/htmx.min.js" defer></script>
        </head>
        <body class={view ? "fam-page fam-view" : "fam-page"}>
          {view ? (
            props.children
          ) : (
            <div class={props.narrow ? "fam-admin fam-admin--narrow" : "fam-admin"}>{props.children}</div>
          )}
          {view ? null : <script>{raw(modalDialogs + copyButtons)}</script>}
        </body>
      </html>
    </>
  );
}

export function Problem(props: { message: string | undefined }) {
  return props.message ? <p class="fam-problem">{props.message}</p> : null;
}
