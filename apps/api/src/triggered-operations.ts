import { timingSafeEqual } from "node:crypto";
import { FamilyIdConflictError, NewerMigrationHistoryError, OldMigrationHistoryError, parseFamilyId, type FamilyId } from "@family-agenda/adapters";
import type { AdminAccess, DueWorkReport, StepOutcome } from "@family-agenda/application";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { runDueWork, workFailures, type BackgroundWork, type WorkLog } from "./background-work";
import type { PreparedFamily } from "./composition-root";
import type { TriggerConfig } from "./config";
import { contextHeader, openContextOutcome, type OpenedContext } from "./context/context";
import { databaseKeyOf, type OpeningProblem, type SuppliedFamilies } from "./context/supplied-families";

/** A step of due work as JSON: its report, or the message of the error it stopped with. */
type StepAnswer<R> = { ok: true; report: R } | { ok: false; error: string };

type DueWorkAnswer = {
  polled: StepAnswer<Extract<DueWorkReport["polled"], { ok: true }>["report"]>;
  extracted: StepAnswer<Extract<DueWorkReport["extracted"], { ok: true }>["report"]>;
};

/** What each Triggered operation answers with, by its name. */
export type TriggerAnswers = {
  "due-work": DueWorkAnswer;
  purge: { purged: number; deleted: number };
  "secret-sweep": { removed: number };
  "prepare-family": PreparedFamily;
  "enter-admin": { email: string; outcome: "first" | "added" | "exists" };
  "reset-admin-password": { email: string; newPassword: string };
};

/**
 * What the Triggered operations act on: the worker's work; Preparing the Family, which works on
 * the Family's database itself, not on a booted Family, so that it also prepares an empty one;
 * and the Admins, for an operator who is not signed in.
 */
export type TriggeredWork = BackgroundWork & {
  prepare(familyId?: FamilyId): Promise<PreparedFamily>;
  admins: Pick<AdminAccess, "enterAdmin" | "issueNewPassword">;
};

type OperationName = keyof TriggerAnswers;
/** Reads the JSON body of the request; only an operation that takes one calls it. */
type BodyReader = () => Promise<unknown>;
type Operations = { [Name in OperationName]: (body: BodyReader) => Promise<TriggerAnswers[Name]> };
/** The operations as served: each may also read the request, such as for the Context it carries. */
type Served = { [Name in OperationName]: (body: BodyReader, request: Request) => Promise<TriggerAnswers[Name]> };

/** Where the Triggered operations write: the worker's lines, and whether they listen. */
export type TriggerLog = WorkLog & { info(line: string): void };

/** The statuses an operation is refused with. */
type RefusalStatus = 400 | 401 | 403 | 404 | 409 | 503;

/** An operation that will not run as asked, answered with `status` and `body`; nothing has changed. */
class Refused extends Error {
  constructor(
    readonly status: RefusalStatus,
    readonly body: Record<string, string>,
  ) {
    super(body.error);
  }
}

/** The Family id a `prepare-family` body names, if any; a body that names no UUID is refused. */
function familyIdIn(body: unknown): FamilyId | undefined {
  const given = typeof body === "object" && body !== null ? (body as { familyId?: unknown }).familyId : undefined;
  if (given === undefined) return undefined;
  const familyId = parseFamilyId(given);
  if (familyId === null) throw new Refused(400, { error: "invalid-family-id" });
  return familyId;
}

async function prepareFamily(work: TriggeredWork, body: BodyReader): Promise<PreparedFamily> {
  const familyId = familyIdIn(await body());
  try {
    return await work.prepare(familyId);
  } catch (error) {
    if (error instanceof FamilyIdConflictError) throw new Refused(409, { error: "family-id-differs", familyId: error.stored });
    throw error;
  }
}

/** The email address a body names, as given; a body that names no text is refused. */
async function emailIn(body: BodyReader): Promise<string> {
  const given: unknown = await body();
  const email = typeof given === "object" && given !== null ? (given as { email?: unknown }).email : undefined;
  if (typeof email !== "string") throw new Refused(400, { error: "invalid-email" });
  return email;
}

async function enterAdmin(work: FamilyWork, body: BodyReader): Promise<TriggerAnswers["enter-admin"]> {
  const result = await work.admins.enterAdmin({ email: await emailIn(body) });
  if (!result.ok) throw new Refused(400, { error: result.problem });
  return { email: result.email, outcome: result.outcome };
}

/** The new password is in the answer alone, never in a log line. */
async function resetAdminPassword(work: FamilyWork, body: BodyReader): Promise<TriggerAnswers["reset-admin-password"]> {
  const result = await work.admins.issueNewPassword({ email: await emailIn(body) });
  if (!result.ok) throw new Refused(result.problem === "invalid-email" ? 400 : 404, { error: result.problem });
  return { email: result.email, newPassword: result.newPassword };
}

const stepOf = <R>(outcome: StepOutcome<R>): StepAnswer<R> =>
  outcome.ok ? outcome : { ok: false, error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };

/** Lets a trigger that arrives while a run is under way wait for that run instead of starting another. */
function joined<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}

/**
 * Lets prepares of one `api` take turns rather than share a run as `joined` does: each may name
 * another Family id and must get its own answer, refused or not. Across containers, the migration
 * lock in Postgres serialises them.
 */
function queued<A extends unknown[], T>(run: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let previous: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const next = previous.then(() => run(...args));
    previous = next.catch(() => {});
    return next;
  };
}

/** What a booted Family's operations act on: all of its Triggered work but Preparing the Family. */
type FamilyWork = Omit<TriggeredWork, "prepare">;
type FamilyOperations = Omit<Operations, "prepare-family">;

const dueWorkAnswer = async (work: FamilyWork, log: WorkLog): Promise<DueWorkAnswer> => {
  const report = await runDueWork(work, log);
  return { polled: stepOf(report.polled), extracted: stepOf(report.extracted) };
};

/** The worker's work as named operations: the same calls, and the same log lines, as its schedules. */
function familyOperations(work: FamilyWork, log: WorkLog, dueWork = joined(() => dueWorkAnswer(work, log))): FamilyOperations {
  return {
    "due-work": dueWork,
    purge: () => work.retention.purge(),
    "secret-sweep": async () => ({ removed: await work.secretSweep.sweep() }),
    "enter-admin": (body) => enterAdmin(work, body),
    "reset-admin-password": (body) => resetAdminPassword(work, body),
  };
}

function triggeredOperations(work: TriggeredWork, log: WorkLog): Operations {
  const { "due-work": dueWork, purge, "secret-sweep": sweep, ...admins } = familyOperations(work, log);
  return { "due-work": dueWork, purge, "secret-sweep": sweep, "prepare-family": queued((body: BodyReader) => prepareFamily(work, body)), ...admins };
}

/** The JSON body of a request; none when it is empty, and refused when it is no JSON. */
async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Refused(400, { error: "invalid-body" });
  }
}

const isOperation = (operations: Served, name: string): name is OperationName => Object.hasOwn(operations, name);

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The interface of Triggered operations: `POST /operations/<name>` runs one and answers with its
 * JSON; every request must carry `Authorization: Bearer <token>`.
 */
export function createTriggerApp(work: TriggeredWork, options: { token: string; log: WorkLog }): Hono {
  return triggerApp(triggeredOperations(work, options.log), options);
}

export type SuppliedTriggerOptions = {
  /** The token that guards the port (`TRIGGER_TOKEN`). */
  token: string;
  /** The key Contexts are sealed with (`CONTEXT_KEY`). */
  contextKey: string;
  /** The Families the core opened, which page requests of the same Context share. */
  families: SuppliedFamilies;
  log: WorkLog;
  now?: () => number;
};

type FamilyOperationName = keyof FamilyOperations;

const openingRefusals: Record<OpeningProblem, () => Refused> = {
  "family-id-differs": () => new Refused(403, { error: "family-id-differs" }),
  "family-not-prepared": () => new Refused(409, { error: "family-not-prepared" }),
  unavailable: () => new Refused(503, { error: "unavailable" }),
};

/** The Context a trigger carries, opened; refused without a valid one, as a page request is. */
function contextOf(request: Request, contextKey: string, now: number): OpenedContext {
  const text = request.headers.get(contextHeader);
  const outcome = text === null ? { ok: false as const, problem: null } : openContextOutcome(contextKey, text, now);
  if (outcome.ok) return outcome.context;
  if (outcome.problem !== null) throw new Refused(400, { error: "invalid-context", problem: outcome.problem });
  throw new Refused(401, { error: "invalid-context" });
}

/** Why preparing a database is refused, by the error it stopped with; nothing has changed. */
function preparingRefusal(error: unknown): Refused | null {
  if (error instanceof FamilyIdConflictError) return new Refused(409, { error: "family-id-differs", familyId: error.stored });
  if (error instanceof NewerMigrationHistoryError) return new Refused(409, { error: "migrated-by-newer-release" });
  if (error instanceof OldMigrationHistoryError) return new Refused(409, { error: "old-data-model" });
  return null;
}

/** In supplied mode the Family id is the Context's: a body may only confirm it. */
async function preparedFor(families: SuppliedFamilies, context: OpenedContext, body: BodyReader, log: WorkLog): Promise<PreparedFamily> {
  const named = familyIdIn(await body());
  if (named !== undefined && named !== context.familyId) throw new Refused(400, { error: "family-id-not-the-contexts" });
  try {
    return await families.prepare(context);
  } catch (error) {
    const refusal = preparingRefusal(error);
    if (refusal) throw refusal;
    // As opening answers a database it cannot reach; the message could name it, so only the kind of error.
    log.error(`${workFailures["prepare-family"]} the Family ${context.familyId}`, error instanceof Error ? error.name : "unknown");
    throw new Refused(503, { error: "unavailable" });
  }
}

/**
 * The Triggered operations of a core in supplied mode (ADR-0003): each request carries the token
 * of the port and the Context of the Family it acts on. Preparing the Family is the one operation
 * that writes to a database the core has not opened; every other opens the Family read-only, as a
 * page request does, and is refused for a database not prepared by this release.
 */
export function createSuppliedTriggerApp(options: SuppliedTriggerOptions): Hono {
  const { contextKey, families, log, now = Date.now } = options;
  // Due work under way, by database: a trigger during a run waits for it, whichever opening it came by.
  const dueWorkRuns = new Map<string, Promise<DueWorkAnswer>>();
  const joinedDueWork = (context: OpenedContext, work: FamilyWork) => {
    const database = databaseKeyOf(context);
    let running = dueWorkRuns.get(database);
    if (!running) {
      running = dueWorkAnswer(work, log).finally(() => dueWorkRuns.delete(database));
      dueWorkRuns.set(database, running);
    }
    return running;
  };
  const onFamily =
    <Name extends FamilyOperationName>(name: Name) =>
    async (body: BodyReader, request: Request): Promise<TriggerAnswers[Name]> => {
      const context = contextOf(request, contextKey, now());
      const opening = await families.serve(context, ({ application }) =>
        familyOperations(application, log, () => joinedDueWork(context, application))[name](body),
      );
      if (opening.ok) return opening.family;
      log.warn(`Could not open the Family ${context.familyId} for the Triggered operation ${name}: ${opening.problem}`);
      throw openingRefusals[opening.problem]();
    };
  return triggerApp(
    {
      "due-work": onFamily("due-work"),
      purge: onFamily("purge"),
      "secret-sweep": onFamily("secret-sweep"),
      "prepare-family": (body, request) => preparedFor(families, contextOf(request, contextKey, now()), body, log),
      "enter-admin": onFamily("enter-admin"),
      "reset-admin-password": onFamily("reset-admin-password"),
    },
    options,
  );
}

function triggerApp(operations: Served, { token, log }: { token: string; log: WorkLog }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!sameToken(c.req.header("authorization") ?? "", `Bearer ${token}`)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.get("/operations", (c) => c.json({ operations: Object.keys(operations) }));
  app.post("/operations/:name", async (c) => {
    const name = c.req.param("name");
    if (!isOperation(operations, name)) return c.json({ error: "unknown-operation" }, 404);
    try {
      return c.json(await operations[name](() => bodyOf(c.req.raw), c.req.raw));
    } catch (error) {
      if (error instanceof Refused) return c.json(error.body, error.status);
      log.error(workFailures[name], error);
      return c.json({ error: "failed" }, 500);
    }
  });
  app.notFound((c) => c.json({ error: "not-found" }, 404));
  return app;
}

/** Listens for Triggered operations on their own port; only with a token, else says once that they are off. */
export function serveTriggers(work: TriggeredWork, trigger: TriggerConfig, log: TriggerLog): ServerType | null {
  return listen((token) => createTriggerApp(work, { token, log }), trigger, log);
}

/** As `serveTriggers`, for a core in supplied mode: every trigger also carries the Context of its Family. */
export function serveSuppliedTriggers(
  options: Omit<SuppliedTriggerOptions, "token" | "log">,
  trigger: TriggerConfig,
  log: TriggerLog,
): ServerType | null {
  return listen((token) => createSuppliedTriggerApp({ ...options, token, log }), trigger, log);
}

function listen(appOf: (token: string) => Hono, trigger: TriggerConfig, log: { info(line: string): void }): ServerType | null {
  if (trigger.token === null) {
    log.info("Triggered operations are off: TRIGGER_TOKEN is not set");
    return null;
  }
  return serve({ fetch: appOf(trigger.token).fetch, port: trigger.port }, (info) => {
    log.info(`Triggered operations listening on port ${info.port}`);
  });
}
