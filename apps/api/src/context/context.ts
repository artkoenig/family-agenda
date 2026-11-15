import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * What a core in supplied mode needs to open the Family a request is for (ADR-0003): a trusted
 * caller seals it with the Context key it shares with the core, and every request carries it.
 */
export type Context = {
  /** The Family id, which the database the Context names must hold. */
  familyId: string;
  /** The Family's database, as a Postgres connection string, password included. */
  databaseUrl: string;
  /** The family key the Family's Source credentials are stored under: 32 bytes, base64url. */
  familyKey: string;
  /** The blob directory the Family's folder lies in. */
  blobDirectory: string;
  /** Milliseconds since the epoch; the Context is refused from then on. */
  expiresAt: number;
};

/** The request header a Context reaches the core in; nowhere else is one read. */
export const contextHeader = "x-family-context";

const familyKeyLength = 32;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const contextSchema = z.strictObject({
  familyId: z.string().regex(uuid),
  databaseUrl: z.string().min(1),
  familyKey: z.string().refine((text) => Buffer.from(text, "base64url").length === familyKeyLength),
  blobDirectory: z.string().min(1),
  expiresAt: z.number(),
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
  const sealed = partsOf(text);
  if (sealed === null) return null;
  const parsed = contextSchema.safeParse(decrypted(contextKey, sealed));
  if (!parsed.success || parsed.data.expiresAt <= now) return null;
  return parsed.data;
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
