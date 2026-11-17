import { z } from "zod";
import { minimumKeyLength } from "../config";
import { maximumContextLifetimeMs, openContextOutcome, sealUncheckedContext } from "./context";

const inputSchema = z.strictObject({
  familyId: z.string(),
  databaseUrl: z.string(),
  familyKey: z.string(),
  blobDirectory: z.string(),
  timeZone: z.string(),
  publicUrl: z.string(),
  organizationId: z.unknown().optional(),
  /** Refused as the core refuses it, naming it (ADR-0009). */
  identityProvider: z.unknown().optional(),
  /** How long the Context lasts, 5 minutes by default. */
  ttlSeconds: z.number().int().positive().max(maximumContextLifetimeMs / 1000).default(300),
});

/**
 * `family-agenda seal-context`: the Context the JSON `input` describes, sealed with `contextKey`,
 * as a trusted caller seals one; refuses one the core would not open. Read from standard input, so
 * that the family key and the database password never appear in a process list.
 */
export function sealContextCommand(contextKey: string, input: string, now: number): string {
  if (contextKey.length < minimumKeyLength) throw new Error("CONTEXT_KEY must be set, at least 32 characters long");
  const parsed = inputSchema.safeParse(parseJson(input));
  if (!parsed.success) throw new Error("Expected JSON { familyId, databaseUrl, familyKey, blobDirectory, timeZone, publicUrl, organizationId?, ttlSeconds? }");
  const { ttlSeconds, ...rest } = parsed.data;
  const sealed = sealUncheckedContext(contextKey, { ...rest, expiresAt: now + ttlSeconds * 1000 });
  const opened = openContextOutcome(contextKey, sealed, now);
  if (!opened.ok) throw new Error(opened.problem ?? "Not a Context the core opens: the Family id must be a UUID, the family key 32 bytes in base64url, the organizationId, if given, not empty");
  return sealed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
