import { timingSafeEqual } from "node:crypto";
import type { DueWorkReport, StepOutcome } from "@family-agenda/application";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { runDueWork, workFailures, type BackgroundWork, type WorkLog } from "./background-work";
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
};

/**
 * What the Triggered operations act on: the worker's work. Preparing the Family is none of them: a
 * core prepares its Family when it starts, or in supplied mode when it opens one. No operation
 * manages Admins, who exist only in the Identity Provider (ADR-0009).
 */
export type TriggeredWork = BackgroundWork;

type OperationName = keyof TriggerAnswers;
type Operations = { [Name in OperationName]: () => Promise<TriggerAnswers[Name]> };
/** The operations as served: each may also read the request, such as for the Context it carries. */
type Served = { [Name in OperationName]: (request: Request) => Promise<TriggerAnswers[Name]> };

/** Where the Triggered operations write: the worker's lines, and whether they listen. */
export type TriggerLog = WorkLog & { info(line: string): void };

/** The statuses an operation is refused with. */
type RefusalStatus = 400 | 401 | 403 | 409 | 503;

/** An operation that will not run as asked, answered with `status` and `body`; nothing has changed. */
class Refused extends Error {
  constructor(
    readonly status: RefusalStatus,
    readonly body: Record<string, string>,
  ) {
    super(body.error);
  }
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

const dueWorkAnswer = async (work: TriggeredWork, log: WorkLog): Promise<DueWorkAnswer> => {
  const report = await runDueWork(work, log);
  return { polled: stepOf(report.polled), extracted: stepOf(report.extracted) };
};

/** The worker's work as named operations: the same calls, and the same log lines, as its schedules. */
function triggeredOperations(work: TriggeredWork, log: WorkLog, dueWork = joined(() => dueWorkAnswer(work, log))): Operations {
  return {
    "due-work": dueWork,
    purge: () => work.retention.purge(),
    "secret-sweep": async () => ({ removed: await work.secretSweep.sweep() }),
  };
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

const openingRefusals: Record<OpeningProblem, () => Refused> = {
  "family-id-differs": () => new Refused(403, { error: "family-id-differs" }),
  "migrated-by-newer-release": () => new Refused(409, { error: "migrated-by-newer-release" }),
  "old-data-model": () => new Refused(409, { error: "old-data-model" }),
  migrating: () => new Refused(503, { error: "migrating" }),
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

/**
 * The Triggered operations of a core in supplied mode (ADR-0003): each request carries the token
 * of the port and the Context of the Family it acts on, and opens the Family as a page request
 * does, preparing a database not yet prepared by this release first.
 */
export function createSuppliedTriggerApp(options: SuppliedTriggerOptions): Hono {
  const { contextKey, families, log, now = Date.now } = options;
  // Due work under way, by database: a trigger during a run waits for it, whichever opening it came by.
  const dueWorkRuns = new Map<string, Promise<DueWorkAnswer>>();
  const joinedDueWork = (context: OpenedContext, work: TriggeredWork) => {
    const database = databaseKeyOf(context);
    let running = dueWorkRuns.get(database);
    if (!running) {
      running = dueWorkAnswer(work, log).finally(() => dueWorkRuns.delete(database));
      dueWorkRuns.set(database, running);
    }
    return running;
  };
  const onFamily =
    <Name extends OperationName>(name: Name) =>
    async (request: Request): Promise<TriggerAnswers[Name]> => {
      const context = contextOf(request, contextKey, now());
      const opening = await families.serve(context, ({ application }) =>
        triggeredOperations(application, log, () => joinedDueWork(context, application))[name](),
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
      return c.json(await operations[name](c.req.raw));
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
