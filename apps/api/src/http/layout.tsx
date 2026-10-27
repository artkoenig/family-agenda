import type { Child } from "hono/jsx";
import { raw } from "hono/html";

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
 * A page in the Family Agenda design system: its tokens and component classes come from
 * `/static/tokens.css` and `/static/design.css` (`design/`). A View is the Family's timeline; every
 * other page belongs to the Admin area, `narrow` for signing in.
 */
export function Layout(props: { title: string; surface?: "view" | "admin"; narrow?: boolean; children: Child }) {
  const view = props.surface === "view";
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
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
          {view ? null : <script>{raw(modalDialogs)}</script>}
        </body>
      </html>
    </>
  );
}

export function Problem(props: { message: string | undefined }) {
  return props.message ? <p class="fam-problem">{props.message}</p> : null;
}
