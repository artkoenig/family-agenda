import { describe, expect, it } from "vitest";
import { FragmentError, LazyFragment, notReadyYet } from "../../src/http/lazy-fragment";

const html = async (node: { toString(): string } | Promise<{ toString(): string }>) => (await node).toString();

const poll = { every: 2, backoff: 1.5, maxSeconds: 10 };

describe("A fragment of a page loaded after it", () => {
  it("shows a spinner with a default text without a placeholder of its own", async () => {
    const markup = await html(<LazyFragment href="/fragment" />);
    expect(markup).toContain('hx-get="/fragment" hx-trigger="load" hx-swap="outerHTML" aria-busy="true" aria-live="polite"');
    expect(markup).toContain('<span class="fam-spinner" aria-hidden="true"></span> Loading…');
  });

  it("explains why it has no content", async () => {
    expect(await html(<FragmentError title="It failed." message="The plugin is down." />)).toBe(
      '<span class="fam-lazy fam-lazy--failed" role="alert"><strong>It failed.</strong> The plugin is down.</span>',
    );
  });

  it("asks again ever later while it is not ready, then says it takes longer than usual", async () => {
    const first = await html(notReadyYet({ href: "/fragment", poll, waitedSeconds: 0 }));
    expect(first).toContain('hx-get="/fragment?waited=2" hx-trigger="load delay:2s"');
    const second = await html(notReadyYet({ href: "/fragment?x=1", poll, waitedSeconds: 2 }));
    expect(second).toContain('hx-get="/fragment?x=1&amp;waited=5" hx-trigger="load delay:3s"');
    const third = await html(notReadyYet({ href: "/fragment", poll, waitedSeconds: 5 }));
    expect(third).toContain('hx-trigger="load delay:4.5s"');
    const late = await html(notReadyYet({ href: "/fragment", poll, waitedSeconds: 10 }));
    expect(late).toContain("This is taking longer than usual.");
    expect(late).not.toContain("hx-get");
  });
});
