import { createHash } from "node:crypto";
import { connectPostgres, FamilyIdConflictError, type PostgresConnection } from "@family-agenda/adapters";
import { FamilyNotPreparedError, openPreparedFamily, prepareFamily, type Application, type FamilyConfig, type PreparedFamily, type SharedWiring } from "../composition-root";
import type { OpenedContext } from "./context";

/** What a Family's pages answer a request with, such as its Hono app's `fetch`. */
export type FamilyFetch = (request: Request, env?: unknown) => Response | Promise<Response>;

/** What every Family gets alike; its time zone, public address and Identity Provider come with its Context. */
export type FamilySettings = Pick<FamilyConfig, "identityProviderClient" | "sourceRunTurns">;

export type SuppliedFamiliesOptions = {
  shared: SharedWiring;
  /** What every Family gets alike; nothing by default. */
  settings?: FamilySettings;
  /** What answers the requests of an opened Family, its Hono app below the Context's public address; made once per opening. */
  serving: (application: Application, context: OpenedContext) => FamilyFetch;
  /** Connects to the database a Context names; to its Postgres server by default. */
  connectDatabase?: (databaseUrl: string) => PostgresConnection;
  /** How long an opened Family stays open without a request, 5 minutes by default. */
  idleMs?: number;
  now?: () => number;
};

/** Why a Context that opened opens no Family. */
export type OpeningProblem = "family-id-differs" | "family-not-prepared" | "unavailable";

export type Opening<T> = { ok: true; family: T } | { ok: false; problem: OpeningProblem; error?: unknown };

/** An opened Family: its application, and what answers its requests. */
export type OpenedFamily = { application: Application; fetch: FamilyFetch };

type Entry = {
  /** The database it was opened on, as `databaseKeyOf` names it. */
  database: string;
  opening: Promise<OpenedFamily>;
  lastUsed: number;
  /** Requests under way, which keep the Family open. */
  active: number;
  /** Replaced by a newer opening after Preparing the Family; closed once no request uses it. */
  retired: boolean;
};

export const defaultIdleMs = 5 * 60_000;

/**
 * The Families a core in supplied mode has opened from Contexts (ADR-0003): what it derived from a
 * Context, its connections and wired application, kept in memory only, keyed by a hash of what
 * opens it, and closed once no request has used it for `idleMs`.
 */
export class SuppliedFamilies {
  readonly #options: SuppliedFamiliesOptions;
  readonly #entries = new Map<string, Entry>();
  /** The prepares under way or waiting, by database: the last of each, which settles without failing. */
  readonly #preparing = new Map<string, Promise<void>>();

  constructor(options: SuppliedFamiliesOptions) {
    this.#options = options;
  }

  /** How many Families are open now. */
  get size(): number {
    return this.#entries.size;
  }

  /** Runs `fn` on the Family `context` opens, which stays open meanwhile. */
  async serve<R>(context: OpenedContext, fn: (family: OpenedFamily) => Promise<R>): Promise<Opening<R>> {
    await this.sweep();
    await this.#afterPreparing(databaseKeyOf(context));
    const entry = this.#entryFor(context);
    entry.active += 1;
    try {
      let opened: OpenedFamily;
      try {
        opened = await entry.opening;
      } catch (error) {
        return { ok: false, problem: problemOf(error), error };
      }
      return { ok: true, family: await fn(opened) };
    } finally {
      await this.#release(entry);
    }
  }

  /** Waits until no prepare of `database` is under way or waiting: a Family is opened on the schema it left. */
  async #afterPreparing(database: string): Promise<void> {
    for (let preparing = this.#preparing.get(database); preparing; preparing = this.#preparing.get(database)) await preparing;
  }

  async #release(entry: Entry): Promise<void> {
    entry.active -= 1;
    entry.lastUsed = this.#now();
    if (entry.retired && entry.active === 0) await closeEntry(entry);
  }

  /**
   * Preparing the Family a Context names, on its database itself, with the Context's Family id: the
   * one way a core in supplied mode writes to a Family's database. Its blobs stay where they are: the
   * blob location is shared, and only the Family's own folder is its. A Family opened before is
   * opened anew by the next request.
   */
  async prepare(context: OpenedContext): Promise<PreparedFamily> {
    const database = databaseKeyOf(context);
    // Prepares of one database take turns; those of others run meanwhile.
    const previous = this.#preparing.get(database) ?? Promise.resolve();
    const run = previous.then(() => this.#prepareNow(context, database));
    const settled = run.then(
      () => {},
      () => {},
    );
    this.#preparing.set(database, settled);
    void settled.then(() => {
      if (this.#preparing.get(database) === settled) this.#preparing.delete(database);
    });
    return run;
  }

  async #prepareNow(context: OpenedContext, database: string): Promise<PreparedFamily> {
    // No request reuses what was opened on the schema before; requests under way finish on it.
    this.#retire(database);
    const { shared, connectDatabase = connectPostgres } = this.#options;
    return prepareFamily(shared, { connectDatabase: () => connectDatabase(context.databaseUrl) }, context.familyId);
  }

  /** Drops the Families opened on `database`, closing each once no request uses it. */
  #retire(database: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.database !== database) continue;
      this.#entries.delete(key);
      entry.retired = true;
      if (entry.active === 0) void closeEntry(entry);
    }
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

  #entryFor(context: OpenedContext): Entry {
    const key = keyOf(context);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const entry: Entry = { database: databaseKeyOf(context), opening: this.#open(context), lastUsed: this.#now(), active: 0, retired: false };
    this.#entries.set(key, entry);
    // A Family that failed to open is tried again with the next request.
    entry.opening.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return entry;
  }

  async #open(context: OpenedContext): Promise<OpenedFamily> {
    const { shared, settings = {}, serving, connectDatabase = connectPostgres } = this.#options;
    // Read only: a Family is prepared by a Triggered operation, never by opening it.
    const application = await openPreparedFamily(shared, {
      ...settings,
      timeZone: context.timeZone,
      identityProvider: context.identityProvider ?? null,
      connectDatabase: () => connectDatabase(context.databaseUrl),
      familyKey: Buffer.from(context.familyKey, "base64url"),
      blobDirectory: context.blobDirectory,
      familyId: context.familyId,
      // All Families of the core share the OCR models, so removing a language leaves its model.
      keepOcrModels: true,
    });
    return { application, fetch: serving(application, context) };
  }
}

function problemOf(error: unknown): OpeningProblem {
  if (error instanceof FamilyIdConflictError) return "family-id-differs";
  return error instanceof FamilyNotPreparedError ? "family-not-prepared" : "unavailable";
}

/** The database a Context names, hashed so that the key holds no password: what Preparing the Family works on. */
export function databaseKeyOf({ databaseUrl }: Pick<OpenedContext, "databaseUrl">): string {
  return createHash("sha256").update(databaseUrl).digest("hex");
}

/**
 * What opens a Family and what it is wired with, hashed so that the key holds no secret; the expiry
 * is no part of it. A Context with other settings for the same Family opens it anew.
 */
function keyOf({ familyId, databaseUrl, familyKey, blobDirectory, timeZone, publicUrl, identityProvider }: OpenedContext): string {
  const provider = identityProvider === undefined ? null : [identityProvider.issuerUrl, identityProvider.clientId, identityProvider.clientSecret, identityProvider.requiredGroup, identityProvider.knownAdminsOnly === true];
  return createHash("sha256").update(JSON.stringify([familyId, databaseUrl, familyKey, blobDirectory, timeZone, publicUrl, provider])).digest("hex");
}

async function closeEntry(entry: Entry): Promise<void> {
  try {
    await (await entry.opening).application.close();
  } catch {
    // It never opened, or is closed already.
  }
}
