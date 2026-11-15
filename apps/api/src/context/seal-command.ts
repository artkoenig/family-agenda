import type { FamilyId } from "@family-agenda/adapters";
import { z } from "zod";
import { minimumKeyLength } from "../config";
import { maximumContextLifetimeMs, openContext, sealContext } from "./context";

const inputSchema = z.strictObject({
  familyId: z.string(),
  databaseUrl: z.string(),
  familyKey: z.string(),
  blobDirectory: z.string(),
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
  if (!parsed.success) throw new Error("Expected JSON { familyId, databaseUrl, familyKey, blobDirectory, ttlSeconds? }");
  const { ttlSeconds, ...rest } = parsed.data;
  const sealed = sealContext(contextKey, { ...rest, familyId: rest.familyId as FamilyId, expiresAt: now + ttlSeconds * 1000 });
  if (openContext(contextKey, sealed, now) === null) throw new Error("Not a Context the core opens: the Family id must be a UUID, the family key 32 bytes in base64url");
  return sealed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
