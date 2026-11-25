import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { type BrowserElement, type DOMWindow, JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";

type Answer = { status: number; body?: string } | "broken";

/** What htmx relies on and jsdom lacks: an XPath evaluation without a result type, and `CSS.escape`. */
function fillGaps(window: DOMWindow) {
  Object.assign(window, { CSS: { escape: (id: string) => id } });
  const prototype = window.XPathExpression.prototype;
  const evaluate = prototype.evaluate;
  prototype.evaluate = function (node, type = 0, result = null) {
    return evaluate.call(this, node, type, result);
  };
}

/** A section's page as a browser runs it: its own scripts and htmx, its content asked of a server at the same origin. */
describe("the page of a section in a browser", () => {
  let instance: HttpTestInstance;
  let server: Server;
  let dom: JSDOM | undefined;
  let answers: Answer[];
  let asked: string[];

  beforeEach(() => {
    answers = [];
    asked = [];
  });

  afterEach(async () => {
    dom?.window.close();
    dom = undefined;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await instance.close();
  });

  /** Opens the page; each time its content is asked for, the platform gives the next of `answers`. */
  const open = async (...given: Answer[]) => openAt("127.0.0.1", ...given);
  const openAt = async (host: string, ...given: Answer[]) => {
    answers.push(...given);
    const htmx = await readFile(createRequire(import.meta.url).resolve("htmx.org/dist/htmx.min.js"), "utf8");
    let html = "";
    server = createServer((request, response) => {
      if (request.url?.startsWith("/admin/")) return void response.setHeader("content-type", "text/html").end(html);
      if (request.url === "/static/htmx.min.js") return void response.end(htmx);
      if (!request.url?.startsWith("/platform/")) return void response.writeHead(404).end();
      asked.push(request.url);
      const answer = answers.shift();
      if (!answer || answer === "broken") return void request.socket.destroy();
      response.writeHead(answer.status, { "content-type": "text/html" }).end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    const src = { en: `${origin}/platform/contract?lang=en`, de: `${origin}/platform/contract?lang=de` };
    instance = await bootHttpForTest({ sections: [{ id: "contract", label: { en: "Contract", de: "Vertrag" }, src }] });
    await instance.app.languages.setLanguage("en");
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance, { subject: "sub-anna", email: "anna@example.org" });
    html = await (await instance.get("/admin/sections/contract", { headers: { cookie } })).text();

    // Without a console of its own, jsdom prints every failed request of the page.
    dom = await JSDOM.fromURL(`http://${host}:${port}/admin/sections/contract`, {
      runScripts: "dangerously",
      resources: "usable",
      virtualConsole: new VirtualConsole(),
      beforeParse: fillGaps,
    });
    return dom.window.document.querySelector("main")!;
  };
  const textOf = (element: BrowserElement) => element.textContent.replace(/\s+/g, " ").trim();
  const retryIn = (main: BrowserElement) => main.querySelector('[role="alert"] button');
  const unavailable = "This content cannot be loaded.";

  it("says that its content is loading, and puts a 2xx answer in its place", async () => {
    const main = await open({ status: 200, body: '<section class="fam-sheet" id="plan">Yearly plan</section>' });
    expect(textOf(main)).toContain("Loading…");
    await vi.waitFor(() => { expect(textOf(main.querySelector("#plan")!)).toBe("Yearly plan"); });
    expect(textOf(main)).not.toContain("Loading…");
    expect(main.querySelector(".fam-lazy")).toBeNull();
    expect(asked).toEqual(["/platform/contract?lang=en"]);
  });

  it.each<[string, Answer]>([
    ["500", { status: 500, body: "<p>Broken inside</p>" }],
    ["404", { status: 404, body: "<p>Broken inside</p>" }],
    ["401", { status: 401, body: "<p>Broken inside</p>" }],
    ["204", { status: 204 }],
    ["a broken connection", "broken"],
  ])("stays, and says that its content cannot be loaded, on %s", async (_, answer) => {
    const main = await open(answer);
    await vi.waitFor(() => { expect(textOf(main.querySelector('[role="alert"]')!)).toBe(`${unavailable}Try again`); });
    expect(textOf(main.querySelector("h1")!)).toBe("Contract");
    expect(textOf(main)).not.toContain("Broken inside");
    expect(main.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(main.querySelector("[aria-busy]")).toBeNull();
    expect(dom!.window.document.querySelector(".fam-settings__nav a[aria-current]")).not.toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("says that its content cannot be loaded where the page is open at another origin than the core's", async () => {
    const main = await openAt("localhost");
    await vi.waitFor(() => { expect(textOf(main.querySelector('[role="alert"]')!)).toBe(`${unavailable}Try again`); });
    expect(asked).toEqual([]);
  });

  it("asks again when told to, as often as it takes", async () => {
    const main = await open({ status: 500 }, "broken", { status: 200, body: '<p id="plan">Yearly plan</p>' });
    for (const times of [1, 2]) {
      await vi.waitFor(() => { expect(retryIn(main)).not.toBeNull(); });
      expect(asked).toHaveLength(times);
      retryIn(main)!.click();
      expect(textOf(main)).toContain("Loading…");
      expect(retryIn(main)).toBeNull();
    }
    await vi.waitFor(() => { expect(main.querySelector("#plan")).not.toBeNull(); });
    expect(asked).toEqual(Array(3).fill("/platform/contract?lang=en"));
  });
});
