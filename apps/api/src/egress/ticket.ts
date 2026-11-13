import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pluginServiceOf, proxyOf, proxyPort } from "./wiring";

/**
 * What the core grants one plugin call (ADR-0001): its Egress Proxy lets the call through to the
 * hosts of this one Source of this one Family, until `expiresAt`. The core signs it with the
 * ticket key it shares with the proxies, so neither a plugin nor anyone else can make one up.
 */
export type Ticket = {
  familyId: string;
  sourceTypeId: string;
  /** Null for a call of no Source, such as for the Catalogue entries, which reaches the declared hosts only. */
  sourceId: string | null;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /**
   * The hosts of a Source that is not stored, such as one being added or one just removed; null
   * for a stored Source, whose host fields the api reads from its Family's database.
   */
  hosts: string[] | null;
};

const ticketSchema = z.object({
  familyId: z.string().min(1),
  sourceTypeId: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  expiresAt: z.number(),
  hosts: z.array(z.string()).nullable(),
});

const signatureOf = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest();

/** `<claims>.<signature>`, both base64url: safe as the password of a proxy URL. */
export function mintTicket(key: string, ticket: Ticket): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${payload}.${signatureOf(key, payload).toString("base64url")}`;
}

/** The ticket `text` grants, or null if it is not one signed with `key` or has expired by `now`. */
export function verifyTicket(key: string, text: string, now: number): Ticket | null {
  const [payload, signature, ...rest] = text.split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) return null;
  const presented = Buffer.from(signature, "base64url");
  const expected = signatureOf(key, payload);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  const parsed = ticketSchema.safeParse(parseJson(Buffer.from(payload, "base64url").toString()));
  if (!parsed.success || parsed.data.expiresAt <= now) return null;
  return parsed.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The ticket in a `Proxy-Authorization` header: the password of Basic credentials, which an HTTP
 * client sends for a proxy URL such as `http://ticket:<ticket>@plugin-imap-egress:3128`, or a
 * Bearer token. Null for none.
 */
export function ticketOfProxyAuthorization(header: string | undefined): string | null {
  const text = (header ?? "").trim();
  const bearer = /^bearer\s+(\S+)$/i.exec(text)?.[1];
  if (bearer !== undefined) return bearer;
  const basic = /^basic\s+(\S+)$/i.exec(text)?.[1] ?? "";
  return /^[^:]*:(.+)$/s.exec(Buffer.from(basic, "base64").toString())?.[1] ?? null;
}

/** What the core mints the tickets of one Family's plugin calls with. */
export type Ticketing = {
  /** The key shared with the egress proxies, from `EGRESS_TICKET_KEY`. */
  ticketKey: string;
  familyId: string;
  now?: () => number;
};

/** How much longer than the call's timeout a ticket lasts, for connections the plugin opens late in the call. */
export const ticketGraceMs = 30_000;

/**
 * The proxy URL a call to the plugin of `sourceTypeId` carries: the plugin's own Egress Proxy, with
 * a ticket for `source` as the password (none for a call of no Source), lasting `timeoutMs` and a
 * little longer.
 */
export function egressProxyFor(
  { ticketKey, familyId, now = Date.now }: Ticketing,
  sourceTypeId: string,
  source: { id: string; hosts: string[] | null } | null,
  timeoutMs: number,
): string {
  const ticket = mintTicket(ticketKey, {
    familyId,
    sourceTypeId,
    sourceId: source?.id ?? null,
    expiresAt: now() + timeoutMs + ticketGraceMs,
    hosts: source?.hosts ?? null,
  });
  return `http://ticket:${ticket}@${proxyOf(pluginServiceOf(sourceTypeId))}:${proxyPort}`;
}
