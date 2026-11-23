import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { parseFamilyId, type FamilyId } from "@family-agenda/adapters";
import { isTimeZone } from "@family-agenda/domain";
import { z } from "zod";
import { parsePublicUrl } from "../config";

/**
 * What a core in supplied mode needs to open the Family a request is for (ADR-0003): a trusted
 * caller seals it with the Context key it shares with the core, and every request carries it.
 */
export type Context = {
  /** The Family id, which the database the Context names must hold. */
  familyId: FamilyId;
  /** The Family's database, as a Postgres connection string, password included. */
  databaseUrl: string;
  /** The family key the Family's Source credentials are stored under: 32 bytes, base64url. */
  familyKey: string;
  /** The blob directory the Family's folder lies in. */
  blobDirectory: string;
  /**
   * The IANA time zone the Family starts with, such as `Europe/Berlin`, stored while it has none;
   * ignored once one is stored, which only an Admin changes. `Europe/Berlin` if left out.
   */
  timeZone?: string;
  /**
   * The address the Family reaches the core at, through the caller, without a trailing slash. Its
   * path is the path prefix: the caller removes it from a request, and the core writes every
   * address, cookie, the web manifest, the Agenda feed and the single sign-on handover below it.
   */
  publicUrl: string;
  /**
   * The Family's organization at the Identity Provider, which the caller learned from
   * `family.created` (ADR-0010): the core records it while the database has none, and refuses a
   * Context naming another. Left out by a caller that registers no Families.
   */
  organizationId?: string;
  /**
   * Milliseconds since the epoch; the Context is refused from then on, after a little skew, and
   * when it lies further ahead than `maximumContextLifetimeMs`.
   */
  expiresAt: number;
};

/** The longest a Context may last: one lasting longer is refused, as `seal-context` refuses to seal one. */
export const maximumContextLifetimeMs = 24 * 60 * 60_000;

/** How long after its expiry a Context is still taken, for clocks of the caller and the core that differ a little. */
export const expirySkewMs = 30_000;

/** The request header a Context reaches the core in; nowhere else is one read. */
export const contextHeader = "x-family-context";

const familyKeyLength = 32;

const publicUrlProblem = "publicUrl must be an http or https address without credentials, query or fragment, such as https://home.example.org/agenda";

/** Problems that name what is wrong, which the trusted caller is told; never a value of the Context. */
const problems = {
  timeZone: "timeZone must be an IANA time zone, such as Europe/Berlin",
  publicUrl: publicUrlProblem,
  identityProvider:
    "identityProvider must not be set: in supplied mode the one Identity Provider comes from the core's OIDC_* variables, and the Family claim decides who signs in (ADR-0009)",
} as const;

const custom = (context: z.RefinementCtx, message: string) => (context.addIssue({ code: "custom", message }), z.NEVER);

const contextSchema = z
  .strictObject({
    familyId: z.string().transform((text, context) => parseFamilyId(text) ?? custom(context, "no UUID")),
    databaseUrl: z.string().min(1),
    familyKey: z.string().refine((text) => Buffer.from(text, "base64url").length === familyKeyLength),
    blobDirectory: z.string().min(1),
    timeZone: z.string({ error: problems.timeZone }).refine(isTimeZone, problems.timeZone).optional(),
    publicUrl: z.string({ error: problems.publicUrl }).transform((text, context) => parsePublicUrl(text) ?? custom(context, problems.publicUrl)),
    // Named when refused, so that a caller still sealing one learns where the Identity Provider went.
    identityProvider: z.unknown().refine((value) => value === undefined, problems.identityProvider).optional(),
    organizationId: z.string().min(1).optional(),
    expiresAt: z.number(),
  })
  // Nothing of it is kept: it was refused unless absent.
  .transform(({ organizationId, timeZone, ...parsed }): Context => {
    delete parsed.identityProvider;
    return { ...parsed, ...(timeZone === undefined ? {} : { timeZone }), ...(organizationId === undefined ? {} : { organizationId }) };
  });

const version = "v1";
const ivLength = 12;
const tagLength = 16;
/** Binds the ciphertext to its purpose and format, so that nothing else sealed with the key opens as a Context. */
const additionalData = Buffer.from(`family-agenda context ${version}`);

/** The AES-256 key derived from the Context key, so that the setting itself is never the cipher key. */
const cipherKeyOf = (contextKey: string): Buffer =>
  Buffer.from(hkdfSync("sha256", contextKey, "family-agenda", `context ${version} aes-256-gcm`, 32));

/** `v1.<iv>.<ciphertext>.<tag>`, all base64url: AES-256-GCM, so that it is both secret and tamper-proof. */
export function sealContext(contextKey: string, context: Context): string {
  return sealUncheckedContext(contextKey, context);
}

/**
 * As `sealContext`, for a description not checked yet, such as what `seal-context` reads: whoever
 * seals one opens it right after, so that the core's own checks refuse it, naming what is wrong.
 */
export function sealUncheckedContext(contextKey: string, context: Record<string, unknown>): string {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKeyOf(contextKey), iv, { authTagLength: tagLength });
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(context)), cipher.final()]);
  return [version, iv, ciphertext, cipher.getAuthTag()].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}

/**
 * The Context `text` carries, or null if it was not sealed with `contextKey`, was altered, is no
 * Context or has expired by `now`. Says nothing about why: a refusal is a refusal.
 */
export function openContext(contextKey: string, text: string, now: number): Context | null {
  const outcome = openContextOutcome(contextKey, text, now);
  return outcome.ok ? outcome.context : null;
}

/**
 * As `openContext`, naming what is wrong with a Context that was sealed with `contextKey` but
 * carries settings the core refuses, such as an `identityProvider` or a wrong time zone: only the
 * trusted caller can seal one, and only it learns why. Of any other refusal it names nothing.
 */
export function openContextOutcome(contextKey: string, text: string, now: number): { ok: true; context: Context } | { ok: false; problem: string | null } {
  const sealed = partsOf(text);
  if (sealed === null) return { ok: false, problem: null };
  const parsed = contextSchema.safeParse(decrypted(contextKey, sealed));
  if (!parsed.success) return { ok: false, problem: namedProblemOf(parsed.error) };
  if (!isLive(parsed.data.expiresAt, now)) return { ok: false, problem: null };
  return { ok: true, context: parsed.data };
}

const namedProblems: ReadonlySet<string> = new Set(Object.values(problems));

/** The first problem of the settings that names what is wrong; null for one in what opens the Family, or for no Context at all. */
function namedProblemOf(error: z.ZodError): string | null {
  return error.issues.map((issue) => issue.message).find((message) => namedProblems.has(message)) ?? null;
}

/** Whether a Context expiring at `expiresAt` is taken at `now`: not expired beyond the skew, and not lasting too long. */
function isLive(expiresAt: number, now: number): boolean {
  return expiresAt + expirySkewMs > now && expiresAt - now <= maximumContextLifetimeMs;
}

type Sealed = { iv: Buffer; ciphertext: Buffer; tag: Buffer };

/** The parts of a sealed Context, or null for text that is none. */
function partsOf(text: string): Sealed | null {
  const parts = text.split(".");
  if (parts.length !== 4 || parts[0] !== version) return null;
  const [iv, ciphertext, tag] = parts.slice(1).map(canonicalBase64url);
  if (iv?.length !== ivLength || tag?.length !== tagLength) return null;
  return ciphertext === undefined ? null : { iv, ciphertext, tag };
}

/** The bytes of `text`, or undefined unless `text` is exactly how they are written: no two texts open alike. */
function canonicalBase64url(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : undefined;
}

function decrypted(contextKey: string, { iv, ciphertext, tag }: Sealed): unknown {
  try {
    const decipher = createDecipheriv("aes-256-gcm", cipherKeyOf(contextKey), iv, { authTagLength: tagLength });
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    // The tag is checked by `final`, in constant time, before anything decrypted is used.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString()) as unknown;
  } catch {
    return null;
  }
}

/** The Context of a request, from its header alone, or null for none that opens. */
export function contextOfRequest(contextKey: string, request: Request, now: number): Context | null {
  const text = request.headers.get(contextHeader);
  return text === null ? null : openContext(contextKey, text, now);
}
