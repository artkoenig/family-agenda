import { timingSafeEqual } from "node:crypto";
import { FamilyIdConflictError, parseFamilyId, type FamilyId } from "@family-agenda/adapters";
import type { AdminAccess, DueWorkReport, StepOutcome } from "@family-agenda/application";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { runDueWork, workFailures, type BackgroundWork, type WorkLog } from "./background-work";
import type { PreparedFamily } from "./composition-root";
import type { TriggerConfig } from "./config";

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
  "enter-admin": { email: string; entered: boolean };
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

/** An operation that will not run as asked, answered with `status` and `body`; nothing has changed. */
class Refused extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
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

async function enterAdmin(work: TriggeredWork, body: BodyReader): Promise<TriggerAnswers["enter-admin"]> {
  const result = await work.admins.enterAdmin({ email: await emailIn(body) });
  if (!result.ok) throw new Refused(400, { error: result.problem });
  return { email: result.email, entered: result.entered };
}

/** The new password is in the answer alone, never in a log line. */
async function resetAdminPassword(work: TriggeredWork, body: BodyReader): Promise<TriggerAnswers["reset-admin-password"]> {
  const result = await work.admins.issueNewPassword({ email: await emailIn(body) });
  if (!result.ok) throw new Refused(404, { error: result.problem });
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
function queuedPrepare(work: TriggeredWork): (body: BodyReader) => Promise<PreparedFamily> {
  let previous: Promise<unknown> = Promise.resolve();
  return (body) => {
    const next = previous.then(() => prepareFamily(work, body));
    previous = next.catch(() => {});
    return next;
  };
}

/** The worker's work as named operations: the same calls, and the same log lines, as its schedules. */
function triggeredOperations(work: TriggeredWork, log: WorkLog): Operations {
  const dueWork = joined(() => runDueWork(work, log));
  return {
    "due-work": async () => {
      const report = await dueWork();
      return { polled: stepOf(report.polled), extracted: stepOf(report.extracted) };
    },
    purge: () => work.retention.purge(),
    "secret-sweep": async () => ({ removed: await work.secretSweep.sweep() }),
    "prepare-family": queuedPrepare(work),
    "enter-admin": (body) => enterAdmin(work, body),
    "reset-admin-password": (body) => resetAdminPassword(work, body),
  };
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

const isOperation = (operations: Operations, name: string): name is OperationName => Object.hasOwn(operations, name);

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
  const { token, log } = options;
  const operations = triggeredOperations(work, log);
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
      return c.json(await operations[name](() => bodyOf(c.req.raw)));
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
export function serveTriggers(work: TriggeredWork, trigger: TriggerConfig, log: WorkLog & { info(line: string): void }): ServerType | null {
  if (trigger.token === null) {
    log.info("Triggered operations are off: TRIGGER_TOKEN is not set");
    return null;
  }
  return serve({ fetch: createTriggerApp(work, { token: trigger.token, log }).fetch, port: trigger.port }, (info) => {
    log.info(`Triggered operations listening on port ${info.port}`);
  });
}
