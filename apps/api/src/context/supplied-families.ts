import { createHash } from "node:crypto";
import type { IdentityProviderSettings } from "@family-agenda/application";
import { connectPostgres, FamilyIdConflictError, NewerMigrationHistoryError, OldMigrationHistoryError, type PostgresConnection } from "@family-agenda/adapters";
import { checkPreparedSchema, FamilyNotPreparedError, openPreparedFamily, prepareFamily, type Application, type FamilyConfig, type SharedWiring } from "../composition-root";
import type { SuppliedIdentityProvider } from "../config";
import type { Context } from "./context";

/** What a Family's pages answer a request with, such as its Hono app's `fetch`. */
export type FamilyFetch = (request: Request, env?: unknown) => Response | Promise<Response>;

/** What every Family gets alike; its time zone and public address come with its Context. */
export type FamilySettings = Pick<FamilyConfig, "identityProviderClient" | "sourceRunTurns">;

export type SuppliedFamiliesOptions = {
  shared: SharedWiring;
  /** What every Family gets alike; nothing by default. */
  settings?: FamilySettings;
  /**
   * The one Identity Provider of the deployment (ADR-0009): each Family signs in through it, its
   * redirect URI below the Context's `publicUrl`, admitting only tokens whose Family claim names
   * the Context's Family. None offers no single sign-on, as in tests that need none.
   */
  identityProvider?: SuppliedIdentityProvider;
  /** What answers the requests of an opened Family, its Hono app below the Context's public address; made once per opening. */
  serving: (application: Application, context: Context) => FamilyFetch;
  /** Connects to the database a Context names; to its Postgres server by default. */
  connectDatabase?: (databaseUrl: string) => PostgresConnection;
  /** How long a request waits for its Family to be prepared before it is answered `migrating`, 20 seconds by default. */
  preparingWaitMs?: number;
  /**
   * How often a request that reuses an opened Family checks its schema again, 5 seconds by default:
   * a newer release may have migrated it meanwhile, on another core.
   */
  schemaCheckMs?: number;
  /** How long an opened Family stays open without a request, 5 minutes by default. */
  idleMs?: number;
  now?: () => number;
};

/** Why a Context that opened opens no Family. */
export type OpeningProblem = "family-id-differs" | "migrated-by-newer-release" | "old-data-model" | "migrating" | "unavailable";

export type Opening<T> = { ok: true; family: T } | { ok: false; problem: OpeningProblem; error?: unknown };

/** An opening refused: what `serve` answers when it serves no request. */
type Refused = Extract<Opening<never>, { ok: false }>;

/** A database this release has not prepared, which `serve` prepares rather than answers. */
type NotPrepared = { ok: false; problem: "not-prepared"; error: unknown };

/** One try at opening a Family: served, refused, or found not prepared. */
type Tried<T> = Opening<T> | NotPrepared;

/** An opened Family: its application, and what answers its requests. */
export type OpenedFamily = { application: Application; fetch: FamilyFetch };

/** An opened Family, and how to check that its database still has this release's schema. */
type Opened = { family: OpenedFamily; checkSchema(): Promise<void> };

type Entry = {
  /** What opens it, as `keyOf` names it. */
  key: string;
  opening: Promise<Opened>;
  lastUsed: number;
  /** When its schema was last checked, on opening or by a request reusing it. */
  checkedAt: number;
  /** The last check: null when it passed, else the error it found. */
  checked: Promise<unknown>;
  /** Requests under way, which keep the Family open. */
  active: number;
  /** No longer reused, as its schema is no longer this release's; closed once no request uses it. */
  dropped: boolean;
};

export const defaultIdleMs = 5 * 60_000;
export const defaultPreparingWaitMs = 20_000;
export const defaultSchemaCheckMs = 5_000;

const late = Symbol("late");

/** A request's wait for preparing, which ends at the same time for all it waits for. */
type Waiting = { within<T>(promise: Promise<T>): Promise<T | typeof late>; stop(): void };

function waitingFor(ms: number): Waiting {
  let timer: NodeJS.Timeout | undefined;
  const over = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => {
      resolve(late);
    }, ms);
  });
  return {
    within: (promise) => Promise.race([promise, over]),
    stop: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * The Families a core in supplied mode has opened from Contexts (ADR-0003): what it derived from a
 * Context, its connections and wired application, kept in memory only, keyed by a hash of what
 * opens it, and closed once no request has used it for `idleMs`.
 */
export class SuppliedFamilies {
  readonly #options: SuppliedFamiliesOptions;
  readonly #entries = new Map<string, Entry>();
  /** The prepare under way, by database: null once it is prepared, or why it is not. */
  readonly #preparing = new Map<string, Promise<Refused | null>>();

  constructor(options: SuppliedFamiliesOptions) {
    this.#options = options;
  }

  /** How many Families are open now. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Runs `fn` on the Family `context` opens, which stays open meanwhile. A database not yet
   * prepared by this release, empty or prepared by an older one, is prepared first, once however
   * many requests open it; a request waits for that up to `preparingWaitMs`, and is then answered
   * `migrating` while the preparing goes on.
   */
  async serve<R>(context: Context, fn: (family: OpenedFamily) => Promise<R>): Promise<Opening<R>> {
    await this.sweep();
    const waiting = waitingFor(this.#options.preparingWaitMs ?? defaultPreparingWaitMs);
    try {
      const first = await this.#serveOpened(context, fn, waiting);
      return first.ok || first.problem !== "not-prepared" ? first : await this.#servePrepared(context, fn, waiting);
    } finally {
      waiting.stop();
    }
  }

  /** Prepares the database `context` names, which opening found not prepared, then serves the request on it. */
  async #servePrepared<R>(context: Context, fn: (family: OpenedFamily) => Promise<R>, waiting: Waiting): Promise<Opening<R>> {
    const refused = await waiting.within(this.#prepared(context));
    if (refused === late) return { ok: false, problem: "migrating" };
    if (refused !== null) return refused;
    const second = await this.#serveOpened(context, fn, waiting);
    // Prepared, and still not this release's schema: a history no release migrates on, such as
    // one with the migrations of another branch. Waiting would not change it.
    return second.ok || second.problem !== "not-prepared" ? second : { ok: false, problem: "unavailable", error: second.error };
  }

  async #serveOpened<R>(context: Context, fn: (family: OpenedFamily) => Promise<R>, waiting: Waiting): Promise<Tried<R>> {
    // A Family is opened on the schema a prepare under way leaves.
    const preparing = this.#preparing.get(databaseKeyOf(context));
    if (preparing && (await waiting.within(preparing)) === late) return { ok: false, problem: "migrating" };
    const entry = this.#entryFor(context);
    entry.active += 1;
    try {
      let opened: Opened;
      try {
        opened = await entry.opening;
      } catch (error) {
        return failureOf(error);
      }
      const stale = await this.#checked(entry, opened);
      if (stale !== null) return failureOf(stale);
      return { ok: true, family: await fn(opened.family) };
    } finally {
      entry.active -= 1;
      entry.lastUsed = this.#now();
      if (entry.dropped && entry.active === 0) await closeEntry(entry);
    }
  }

  /**
   * Checks the schema of a reused Family again, at most every `schemaCheckMs`; requests meanwhile
   * share the last check. Null while it is this release's; otherwise the Family is dropped, and
   * the error found is the answer.
   */
  async #checked(entry: Entry, opened: Opened): Promise<unknown> {
    const now = this.#now();
    if (now - entry.checkedAt >= (this.#options.schemaCheckMs ?? defaultSchemaCheckMs)) {
      entry.checkedAt = now;
      entry.checked = opened.checkSchema().then(
        () => null,
        (error: unknown) => error,
      );
    }
    const stale = await entry.checked;
    if (stale !== null) this.#drop(entry);
    return stale;
  }

  /** Opens the Family anew for the next request, and closes this opening once no request uses it. */
  #drop(entry: Entry): void {
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    entry.dropped = true;
  }

  /**
   * Preparing the Family a Context names, on its database itself, with the Context's Family id, as
   * opening a database not yet prepared by this release does. Requests that open it meanwhile wait
   * for the same prepare: nothing is prepared twice. Its blobs stay where they are: the blob
   * location is shared, and only the Family's own folder is its.
   */
  #prepared(context: Context): Promise<Refused | null> {
    const database = databaseKeyOf(context);
    const under = this.#preparing.get(database);
    if (under) return under;
    const { shared, connectDatabase = connectPostgres } = this.#options;
    const run = prepareFamily(shared, { connectDatabase: () => connectDatabase(context.databaseUrl) }, context.familyId).then(
      () => null,
      (error: unknown): Refused => ({ ok: false, problem: refusalOf(error), error }),
    );
    this.#preparing.set(database, run);
    void run.then(() => this.#preparing.delete(database));
    return run;
  }

  /** Closes the Families no request has used for `idleMs`. */
  async sweep(): Promise<void> {
    const idleSince = this.#now() - (this.#options.idleMs ?? defaultIdleMs);
    const idle = [...this.#entries].filter(([, entry]) => entry.active === 0 && entry.lastUsed <= idleSince);
    for (const [key] of idle) this.#entries.delete(key);
    await Promise.all(idle.map(([, entry]) => closeEntry(entry)));
  }

  /** Closes every open Family. */
  async close(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(closeEntry));
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #entryFor(context: Context): Entry {
    const key = keyOf(context);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    // Opening checks the schema, so the first check of a reuse is due `schemaCheckMs` after.
    const entry: Entry = { key, opening: this.#open(context), lastUsed: this.#now(), checkedAt: this.#now(), checked: Promise.resolve(null), active: 0, dropped: false };
    this.#entries.set(key, entry);
    // A Family that failed to open is tried again with the next request.
    entry.opening.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return entry;
  }

  async #open(context: Context): Promise<Opened> {
    const { shared, settings = {}, identityProvider, serving, connectDatabase = connectPostgres } = this.#options;
    const postgres = connectDatabase(context.databaseUrl);
    // Refuses a database not prepared by this release before it writes anything, for `serve` to prepare it.
    const application = await openPreparedFamily(shared, {
      ...settings,
      timeZone: context.timeZone,
      identityProvider: identityProviderOf(identityProvider, context),
      connectDatabase: () => postgres,
      familyKey: Buffer.from(context.familyKey, "base64url"),
      blobDirectory: context.blobDirectory,
      familyId: context.familyId,
      // All Families of the core share the OCR models, so removing a language leaves its model.
      keepOcrModels: true,
    });
    return { family: { application, fetch: serving(application, context) }, checkSchema: () => checkPreparedSchema(postgres) };
  }
}

/** The Identity Provider as one Family signs in through it: below its address, for its Family alone. */
function identityProviderOf(provider: SuppliedIdentityProvider | undefined, context: Context): IdentityProviderSettings | null {
  if (provider === undefined) return null;
  const { familyIdClaim, ...connection } = provider;
  return { ...connection, publicBaseUrl: context.publicUrl, family: { claim: familyIdClaim, familyId: context.familyId } };
}

/** What a failed opening, or a failed check of an opened Family, answers. */
function failureOf(error: unknown): Refused | NotPrepared {
  return error instanceof FamilyNotPreparedError ? { ok: false, problem: "not-prepared", error } : { ok: false, problem: refusalOf(error), error };
}

/** Why opening or preparing a Family refused it, by the error it stopped with. */
function refusalOf(error: unknown): OpeningProblem {
  if (error instanceof FamilyIdConflictError) return "family-id-differs";
  if (error instanceof NewerMigrationHistoryError) return "migrated-by-newer-release";
  return error instanceof OldMigrationHistoryError ? "old-data-model" : "unavailable";
}

/** The database a Context names, hashed so that the key holds no password: what Preparing the Family and due work go by. */
export function databaseKeyOf({ databaseUrl }: Pick<Context, "databaseUrl">): string {
  return createHash("sha256").update(databaseUrl).digest("hex");
}

/**
 * What opens a Family and what it is wired with, hashed so that the key holds no secret; the expiry
 * is no part of it. A Context with other settings for the same Family opens it anew.
 */
function keyOf({ familyId, databaseUrl, familyKey, blobDirectory, timeZone, publicUrl }: Context): string {
  return createHash("sha256").update(JSON.stringify([familyId, databaseUrl, familyKey, blobDirectory, timeZone, publicUrl])).digest("hex");
}

async function closeEntry(entry: Entry): Promise<void> {
  try {
    await (await entry.opening).family.application.close();
  } catch {
    // It never opened, or is closed already.
  }
}
