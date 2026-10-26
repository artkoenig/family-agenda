import type { Child } from "hono/jsx";
import { raw } from "hono/html";

const adminStyles = `
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 40rem; padding: 1rem; background: #111418; color: #e6e8eb; }
  form { display: grid; gap: .5rem; margin: 1rem 0; }
  input, button { font: inherit; padding: .5rem; }
  .problem { color: #ff8a80; }
  nav { display: flex; gap: 1rem; align-items: center; }
  a { color: #8ab4f8; }
  .secret { font-family: ui-monospace, monospace; font-size: 1.1rem; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 1rem; align-items: center; }
  fieldset { display: grid; gap: .25rem; border: 1px solid #2c3138; }
  .entries { list-style: none; padding: 0; }
  .entries > li { border-bottom: 1px solid #2c3138; padding: .5rem 0; }
  .av { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%;
    overflow: hidden; color: #fff; font-weight: 700; background: #475569; }
  .av img { width: 100%; height: 100%; object-fit: cover; }
  @media print {
    :root { color-scheme: light; }
    body { background: #fff; color: #000; }
    nav, form, .actions { display: none; }
  }
`;

/** `styles` replaces the Admin area's styles, as for a View. */
export function Layout(props: { title: string; styles?: string; children: Child }) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title} · Family Butler</title>
          <style>{raw(props.styles ?? adminStyles)}</style>
          <script src="/static/htmx.min.js" defer></script>
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}

export function Problem(props: { message: string | undefined }) {
  return props.message ? <p class="problem">{props.message}</p> : null;
}
