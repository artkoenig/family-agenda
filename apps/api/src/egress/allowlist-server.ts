import { Hono } from "hono";
import { allowlistOf, type AllowlistSources } from "./allowlist";

/**
 * Serves each container's allowlist to its egress proxy at `/egress/<service>`, as `{ hosts }`.
 * It listens on a port of its own that compose does not publish, so only the Instance's own
 * network reaches it.
 */
export function createAllowlistApp(sources: AllowlistSources): Hono {
  const app = new Hono();
  app.get("/egress/:service", async (c) => c.json({ hosts: await allowlistOf(c.req.param("service"), sources) }));
  return app;
}
