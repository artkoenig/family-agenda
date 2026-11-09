import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { allowlistOf, type AllowlistSources } from "./allowlist";

/**
 * Serves each container's allowlist to its egress proxy at `/egress/<service>`, as `{ hosts }`.
 * It listens on a port of its own that compose does not publish. The api shares the plugin
 * networks, so each proxy proves itself with its own token (`Authorization: Bearer <token>`),
 * which reads its own container's allowlist only; anything else is refused with 403.
 */
export function createAllowlistApp(sources: AllowlistSources, tokens: Map<string, string>): Hono {
  const app = new Hono();
  app.get("/egress/:service", async (c) => {
    const service = c.req.param("service");
    const expected = tokens.get(service);
    const presented = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (expected === undefined || presented === undefined || !sameSecret(presented, expected)) return c.json({ error: "forbidden" }, 403);
    return c.json({ hosts: await allowlistOf(service, sources) });
  });
  return app;
}

const digest = (text: string) => createHash("sha256").update(text).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
