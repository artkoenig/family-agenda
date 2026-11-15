import { describe, expect, it } from "vitest";
import { stylesheetBelow } from "../../src/http/href";

describe("a stylesheet below a path prefix", () => {
  const css = [
    '@import "/static/a.css";',
    "@import '/static/b.css';",
    '@import url("/static/c.css");',
    'src: url("/static/fonts/d.woff2");',
    "src: url('/static/fonts/e.woff2');",
    "background: url(/static/avatars/f.svg);",
    "background: url( /static/avatars/g.svg );",
    'background: url("https://example.org/static/h.png"), url(data:image/svg+xml,x);',
  ].join("\n");

  it("moves every address from the root of the Instance below the prefix, however it is quoted", () => {
    expect(stylesheetBelow("/agenda", css)).toBe(
      [
        '@import "/agenda/static/a.css";',
        "@import '/agenda/static/b.css';",
        '@import url("/agenda/static/c.css");',
        'src: url("/agenda/static/fonts/d.woff2");',
        "src: url('/agenda/static/fonts/e.woff2');",
        "background: url(/agenda/static/avatars/f.svg);",
        "background: url( /agenda/static/avatars/g.svg );",
        'background: url("https://example.org/static/h.png"), url(data:image/svg+xml,x);',
      ].join("\n"),
    );
  });

  it("leaves a stylesheet as it is without a prefix", () => {
    expect(stylesheetBelow("", css)).toBe(css);
  });
});
