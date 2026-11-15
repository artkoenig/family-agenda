import { createHash } from "node:crypto";
import { connectPostgres, FamilyIdConflictError, type PostgresConnection } from "@family-agenda/adapters";
import { FamilyNotPreparedError, openPreparedFamily, type Application, type FamilyConfig, type SharedWiring } from "../composition-root";
import type { Context } from "./context";

/** What a Family's pages answer a request with, such as its Hono app's `fetch`. */
export type FamilyFetch = (request: Request, env?: unknown) => Response | Promise<Response>;

/** What every Family gets from the environment, until a Context carries its settings too. */
export type FamilySettings = Pick<FamilyConfig, "timeZone" | "identityProvider" | "identityProviderClient" | "sourceRunTurns">;

export type SuppliedFamiliesOptions = {
  shared: SharedWiring;
  settings: FamilySettings;
  /** What answers the requests of an opened Family, its Hono app; made once per opening. */
  serving: (application: Application) => FamilyFetch;
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
  opening: Promise<OpenedFamily>;
  lastUsed: number;
  /** Requests under way, which keep the Family open. */
  active: number;
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

  constructor(options: SuppliedFamiliesOptions) {
    this.#options = options;
  }

  /** How many Families are open now. */
  get size(): number {
    return this.#entries.size;
  }

  /** Runs `fn` on the Family `context` opens, which stays open meanwhile. */
  async serve<R>(context: Context, fn: (family: OpenedFamily) => Promise<R>): Promise<Opening<R>> {
    await this.sweep();
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
      entry.active -= 1;
      entry.lastUsed = this.#now();
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

  #entryFor(context: Context): Entry {
    const key = keyOf(context);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const entry: Entry = { opening: this.#open(context), lastUsed: this.#now(), active: 0 };
    this.#entries.set(key, entry);
    // A Family that failed to open is tried again with the next request.
    entry.opening.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return entry;
  }

  async #open(context: Context): Promise<OpenedFamily> {
    const { shared, settings, serving, connectDatabase = connectPostgres } = this.#options;
    // Read only: a Family is prepared by a Triggered operation, never by opening it.
    const application = await openPreparedFamily(shared, {
      ...settings,
      connectDatabase: () => connectDatabase(context.databaseUrl),
      familyKey: Buffer.from(context.familyKey, "base64url"),
      blobDirectory: context.blobDirectory,
      familyId: context.familyId,
    });
    return { application, fetch: serving(application) };
  }
}

function problemOf(error: unknown): OpeningProblem {
  if (error instanceof FamilyIdConflictError) return "family-id-differs";
  return error instanceof FamilyNotPreparedError ? "family-not-prepared" : "unavailable";
}

/** What opens a Family, hashed so that the key holds no secret; the expiry is no part of it. */
function keyOf({ familyId, databaseUrl, familyKey, blobDirectory }: Context): string {
  return createHash("sha256").update(JSON.stringify([familyId, databaseUrl, familyKey, blobDirectory])).digest("hex");
}

async function closeEntry(entry: Entry): Promise<void> {
  try {
    await (await entry.opening).application.close();
  } catch {
    // It never opened, or is closed already.
  }
}
