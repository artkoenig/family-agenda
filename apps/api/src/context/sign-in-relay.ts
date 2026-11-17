import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { completeSignIn, signedOutPath, type AdmittedIdentity, type IdentityProviderClient, type InvitationAcceptance, type SignInSecrets } from "@family-agenda/application";
import { z } from "zod";
import type { SuppliedIdentityProvider } from "../config";
import { handoverPath, type FamilySignInRelay } from "../http/app";
import type { Context } from "./context";

/** How long a sign-in may stay at the Identity Provider: its `state` is refused after. */
export const signInStateLifetimeMs = 10 * 60_000;

/** How long a sign-out may stay at the Identity Provider before it returns through the one callback: it is sent nowhere after. */
export const signOutStateLifetimeMs = 10 * 60_000;

/** How long the handover from the one callback to the Family's address may take: it is refused after. */
export const handoverLifetimeMs = 60_000;


export type SignInRelayOptions = {
  /** The key the `state` and the handover are sealed with, derived from `CONTEXT_KEY`: only the core opens them. */
  contextKey: string;
  identityProvider: SuppliedIdentityProvider;
  client: IdentityProviderClient;
  /** With a management API: admits an invitee who is not yet a member of the Family's organization (ADR-0010). */
  acceptInvitation?: InvitationAcceptance;
  now?: () => number;
};

/** The sign-in a Family began, sealed into the `state` it sends to the Identity Provider. */
const stateSchema = z.strictObject({
  familyId: z.string().min(1),
  /** The Family's address, from its Context: where the sign-in is handed over to. */
  returnTo: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
  /** The hash of what the browser that began it holds in a cookie below the Family's address. */
  binding: z.string().min(1),
  /** The id of the Family's organization at the Identity Provider, which the token's organizations must contain (ADR-0010); null before there is one. */
  organizationId: z.string().min(1).nullable(),
  expiresAt: z.number(),
});

/** Who signed in for which Family, sealed for the Family's pages to take once. */
const handoverSchema = z.strictObject({
  id: z.string().min(1),
  familyId: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().min(1),
  /** The ID token of the sign-in, for the Family to sign out at the Identity Provider too. */
  idToken: z.string().min(1).optional(),
  binding: z.string().min(1),
  expiresAt: z.number(),
});

/** Where a browser that signed out at the Identity Provider returns to: its Family's address, sealed into the `state` of the sign-out. */
const signedOutSchema = z.strictObject({
  returnTo: z.string().min(1),
  expiresAt: z.number(),
});

type Purpose = "state" | "handover" | "signed-out";

const version = "v1";
const ivLength = 12;
const tagLength = 16;

/** One key per purpose, so that a `state` never opens as a handover, nor either as a Context. */
const keyOf = (contextKey: string, purpose: Purpose): Buffer =>
  Buffer.from(hkdfSync("sha256", contextKey, "family-agenda", `sign-in ${purpose} ${version} aes-256-gcm`, 32));

/** `v1.<iv>.<ciphertext>.<tag>`, base64url: AES-256-GCM, so that it is both secret and tamper-proof. */
function seal(contextKey: string, purpose: Purpose, value: object): string {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", keyOf(contextKey, purpose), iv, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from(`family-agenda sign-in ${purpose} ${version}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [version, ...[iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString("base64url"))].join(".");
}

/** The iv, ciphertext and tag of `text`, if it has the form `seal` gives; else null. */
function partsOf(text: string): Buffer[] | null {
  const [given, ...parts] = text.split(".");
  return given === version && parts.length === 3 ? parts.map((part) => Buffer.from(part, "base64url")) : null;
}

/** What `text` holds, if this core sealed it for `purpose`, unaltered and not expired by `now`; else null. */
function opened<T extends { expiresAt: number }>(contextKey: string, purpose: Purpose, schema: z.ZodType<T>, text: string, now: number): T | null {
  const [iv, ciphertext, tag] = partsOf(text) ?? [];
  if (!iv || !ciphertext || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyOf(contextKey, purpose), iv, { authTagLength: tagLength });
    decipher.setAAD(Buffer.from(`family-agenda sign-in ${purpose} ${version}`));
    decipher.setAuthTag(tag);
    const parsed = schema.safeParse(JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString()));
    return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
  } catch {
    return null;
  }
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("base64url");

/** Whether two hashes are equal, in constant time. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const answer = (status: number, headers: Record<string, string>, body: string | null = null) =>
  new Response(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers } });

/**
 * Single sign-on in supplied mode (ADR-0009): the deployment registers one redirect URI with the
 * Identity Provider, `OIDC_CALLBACK_URL`, while every Family has its own address. A Family seals
 * its id, its address and the sign-in's secrets into the `state`; the one callback opens it, checks
 * the token's Family claim against it and hands the sign-in over to the Family's address, where the
 * browser that began it, and only that one, takes it once.
 */
export class SignInRelay {
  readonly #options: SignInRelayOptions;
  /** The handovers taken, until they expire: each is taken once. */
  readonly #taken = new Map<string, number>();

  constructor(options: SignInRelayOptions) {
    this.#options = options;
  }

  /** The path of `OIDC_CALLBACK_URL`, which the core answers without a Context. */
  get callbackPath(): string {
    return new URL(this.#options.identityProvider.callbackUrl).pathname;
  }

  /**
   * How the Family at `returnTo` makes the `state` of a sign-in, bound to the browser holding
   * `binding`. The address comes from the Context, so it is never one a browser chose.
   */
  stateOf(familyId: string, returnTo: string, binding: string, organizationId: string | null = null): (secrets: SignInSecrets) => string {
    return (secrets) =>
      seal(this.#options.contextKey, "state", {
        familyId,
        returnTo,
        ...secrets,
        binding: hashOf(binding),
        organizationId,
        expiresAt: this.#now() + signInStateLifetimeMs,
      } satisfies z.infer<typeof stateSchema>);
  }

  /**
   * Answers the Identity Provider's redirect to `OIDC_CALLBACK_URL`: with a handover to the
   * Family's address, or to its sign-in page naming why someone is refused. A `state` not sealed by
   * this core, altered or expired is refused, and sends the browser nowhere.
   */
  async callback(request: Request): Promise<Response> {
    const query = new URL(request.url).search;
    const sealed = new URLSearchParams(query).get("state") ?? "";
    const state = opened(this.#options.contextKey, "state", stateSchema, sealed, this.#now());
    // The one callback is the post-logout redirect URI as well: back to the sign-in of the Family that signed out.
    const signedOut = state === null ? opened(this.#options.contextKey, "signed-out", signedOutSchema, sealed, this.#now()) : null;
    if (signedOut !== null) return answer(303, { location: `${signedOut.returnTo}${signedOutPath}` });
    if (state === null) return answer(400, { "content-type": "text/plain; charset=utf-8" }, "The sign-in could not be completed. Start it again.");
    const { familyIdClaim, ...connection } = this.#options.identityProvider;
    const admitted = await completeSignIn(
      this.#options.client,
      { ...connection, publicBaseUrl: state.returnTo, family: { claim: familyIdClaim, familyId: state.familyId } },
      query,
      { state: sealed, nonce: state.nonce, codeVerifier: state.codeVerifier },
      state.organizationId,
      this.#options.acceptInvitation,
    );
    if (!admitted.ok) return answer(303, { location: `${state.returnTo}/admin/sign-in?problem=${admitted.problem}` });
    const handover = seal(this.#options.contextKey, "handover", {
      id: randomBytes(16).toString("base64url"),
      familyId: state.familyId,
      ...admitted.identity,
      binding: state.binding,
      expiresAt: this.#now() + handoverLifetimeMs,
    } satisfies z.infer<typeof handoverSchema>);
    return answer(303, { location: `${state.returnTo}${handoverPath}?token=${encodeURIComponent(handover)}` });
  }

  /**
   * Who `token` hands over to the Family `familyId`, if it was sealed by this core for that Family
   * and for the browser holding `binding`, has not expired and was not taken before; null otherwise.
   * Taking it uses it up.
   */
  take(token: string, familyId: string, binding: string): AdmittedIdentity | null {
    const now = this.#now();
    for (const [id, expiresAt] of this.#taken) if (expiresAt <= now) this.#taken.delete(id);
    const handover = opened(this.#options.contextKey, "handover", handoverSchema, token, now);
    if (handover === null || handover.familyId !== familyId || binding === "" || !sameHash(handover.binding, hashOf(binding))) return null;
    if (this.#taken.has(handover.id)) return null;
    this.#taken.set(handover.id, handover.expiresAt);
    return { subject: handover.subject, email: handover.email, idToken: handover.idToken };
  }

  /** The `state` of a sign-out at the Identity Provider by the Family at `returnTo`, which the one callback sends back there. */
  signedOutState(returnTo: string): string {
    return seal(this.#options.contextKey, "signed-out", { returnTo, expiresAt: this.#now() + signOutStateLifetimeMs } satisfies z.infer<typeof signedOutSchema>);
  }

  /** The relay as the Family of `context` uses it: its `state` returns to its address, and it takes only handovers for it. */
  forFamily(context: Pick<Context, "familyId" | "publicUrl">): FamilySignInRelay {
    return {
      stateOf: (binding, organizationId) => this.stateOf(context.familyId, context.publicUrl, binding, organizationId),
      take: (token, binding) => this.take(token, context.familyId, binding),
      signedOutState: () => this.signedOutState(context.publicUrl),
    };
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}
