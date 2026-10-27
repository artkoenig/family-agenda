import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

describe("the design system over HTTP", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("serves the tokens and the component classes without a session", async () => {
    for (const path of ["/static/tokens.css", "/static/design.css"]) {
      const response = await instance.get(path);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    }
    expect(await (await instance.get("/static/tokens.css")).text()).toContain("--hearth:");
  });

  it("serves every font file the tokens name, and nothing else", async () => {
    const tokens = await (await instance.get("/static/tokens.css")).text();
    const files = [...tokens.matchAll(/url\("(\/static\/fonts\/[^"]+)"\)/g)].map((match) => match[1]!);

    expect(files).toHaveLength(6);
    for (const file of files) {
      const response = await instance.get(file);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/woff2");
    }
    expect((await instance.get("/static/fonts/unknown.woff2")).status).toBe(404);
    expect((await instance.get("/static/unknown.css")).status).toBe(404);
  });

  it("links both stylesheets from a page", async () => {
    const page = await (await instance.get("/setup")).text();

    expect(page).toContain('href="/static/tokens.css"');
    expect(page).toContain('href="/static/design.css"');
  });
});
