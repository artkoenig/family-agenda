import { Hono } from "hono";
import { allowlistOf, type AllowlistSources } from "./allowlist";
import { verifyTicket } from "./ticket";

export type AllowlistDeps = AllowlistSources & {
  /** The key the core signs tickets with, shared with the egress proxies. */
  ticketKey: string;
  now?: () => number;
};

/**
 * Serves a plugin container's egress proxy what it allows for one plugin call, at
 * `/egress/<service>`, as `{ hosts }`. It listens on a port of its own that compose does not
 * publish. The proxy passes on the ticket the call came with (`Authorization: Bearer <ticket>`):
 * without one the answer is 401; for an expired, forged or unknown one, or one for another
 * container, 403.
 */
export function createAllowlistApp({ ticketKey, declared, family, now = Date.now }: AllowlistDeps): Hono {
  const app = new Hono();
  app.get("/egress/:service", async (c) => {
    const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (presented === undefined) return c.json({ error: "no ticket" }, 401);
    const ticket = verifyTicket(ticketKey, presented, now());
    const hosts = ticket === null ? null : await allowlistOf(c.req.param("service"), ticket, { declared, family });
    return hosts === null ? c.json({ error: "forbidden" }, 403) : c.json({ hosts });
  });
  return app;
}
