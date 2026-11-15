import { timingSafeEqual } from "node:crypto";
import type { DueWorkReport, StepOutcome } from "@family-agenda/application";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { runDueWork, workFailures, type BackgroundWork, type WorkLog } from "./background-work";
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
};

type OperationName = keyof TriggerAnswers;
type Operations = { [Name in OperationName]: () => Promise<TriggerAnswers[Name]> };

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

/** The worker's work as named operations: the same calls, and the same log lines, as its schedules. */
function triggeredOperations(work: BackgroundWork, log: WorkLog): Operations {
  const dueWork = joined(() => runDueWork(work, log));
  return {
    "due-work": async () => {
      const report = await dueWork();
      return { polled: stepOf(report.polled), extracted: stepOf(report.extracted) };
    },
    purge: () => work.retention.purge(),
    "secret-sweep": async () => ({ removed: await work.secretSweep.sweep() }),
  };
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
export function createTriggerApp(work: BackgroundWork, options: { token: string; log: WorkLog }): Hono {
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
      return c.json(await operations[name]());
    } catch (error) {
      log.error(workFailures[name], error);
      return c.json({ error: "failed" }, 500);
    }
  });
  app.notFound((c) => c.json({ error: "not-found" }, 404));
  return app;
}

/** Listens for Triggered operations on their own port; only with a token, else says once that they are off. */
export function serveTriggers(work: BackgroundWork, trigger: TriggerConfig, log: WorkLog & { info(line: string): void }): ServerType | null {
  if (trigger.token === null) {
    log.info("Triggered operations are off: TRIGGER_TOKEN is not set");
    return null;
  }
  return serve({ fetch: createTriggerApp(work, { token: trigger.token, log }).fetch, port: trigger.port }, (info) => {
    log.info(`Triggered operations listening on port ${info.port}`);
  });
}
