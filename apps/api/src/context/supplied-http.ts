import type { HealthResponse } from "@family-agenda/contracts";
import { contextHeader, contextOfRequest } from "./context";
import type { SuppliedFamilies } from "./supplied-families";

export type { FamilyFetch } from "./supplied-families";

/** Where refusals are written: never a Context, a family key or a database password. */
export type ContextLog = { warn(message: string): void };

export type SuppliedHttpOptions = {
  /** The key shared with the trusted caller in front (`CONTEXT_KEY`). */
  contextKey: string;
  families: SuppliedFamilies;
  version: string;
  log: ContextLog;
  now?: () => number;
};

const refusal = (status: 401 | 403 | 409 | 503, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * The pages listener of a core in supplied mode: every request must carry a valid Context in its
 * header, which opens the Family it is for; the Family's pages then answer it, the header removed.
 * Only the health check, which names no Family, answers without one.
 */
export function suppliedFetch({ contextKey, families, version, log, now = Date.now }: SuppliedHttpOptions) {
  return async (request: Request, env?: unknown): Promise<Response> => {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ status: "ok", version } satisfies HealthResponse);
    }
    const context = contextOfRequest(contextKey, request, now());
    if (context === null) {
      log.warn("Refused a request without a valid Context");
      return refusal(401, "A valid Context is required.");
    }
    const opening = await families.serve(context, async (family) => family.fetch(withoutContext(request), env));
    if (opening.ok) return opening.family;
    log.warn(`Could not open the Family ${context.familyId} from its Context: ${opening.problem}${nameOf(opening.error)}`);
    return refusalOf[opening.problem]();
  };
}

const refusalOf = {
  "family-id-differs": () => refusal(403, "The Context names a database of another Family."),
  "family-not-prepared": () => refusal(409, "family-not-prepared: the database the Context names holds no prepared Family."),
  unavailable: () => refusal(503, "The Family cannot be opened now."),
} as const;

/** The request as the Family's pages see it: the Context is the caller's, and goes no further. */
function withoutContext(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(contextHeader);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  });
}

/** Only the kind of error: its message could name the database it came from. */
const nameOf = (error: unknown): string => (error instanceof Error ? ` (${error.name})` : "");
