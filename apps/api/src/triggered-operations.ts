import { timingSafeEqual } from "node:crypto";
import type { DueWorkReport, StepOutcome } from "@family-agenda/application";
import { Hono } from "hono";
import type { BackgroundWork } from "./background-work";

/** The JSON an operation answers with: what it ran and what failed. */
type Answer = Record<string, unknown>;

/** A named operation that runs once and answers with what it did. */
type Operation = () => Promise<Answer>;

export type TriggerOptions = {
  /** When set, a trigger must carry `Authorization: Bearer <token>`; from `TRIGGER_TOKEN`. */
  token: string | null;
};

const stepOf = <R>(outcome: StepOutcome<R>) =>
  outcome.ok ? outcome : { ok: false, error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };

const dueWorkAnswer = (report: DueWorkReport): Answer => ({ polled: stepOf(report.polled), extracted: stepOf(report.extracted) });

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

/** The worker's work as named operations, the same calls its schedules make. */
export function triggeredOperations(work: BackgroundWork): Record<string, Operation> {
  const dueWork = joined(() => work.dueWork.run());
  return {
    "due-work": async () => dueWorkAnswer(await dueWork()),
    purge: async () => await work.retention.purge(),
    "secret-sweep": async () => ({ removed: await work.secretSweep.sweep() }),
  };
}

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The interface of triggered operations, served on a port of its own that is not published:
 * `POST /operations/<name>` runs one and answers with its JSON.
 */
export function createTriggerApp(work: BackgroundWork, options: TriggerOptions): Hono {
  const operations = triggeredOperations(work);
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (options.token !== null && !sameToken(c.req.header("authorization") ?? "", `Bearer ${options.token}`)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.get("/operations", (c) => c.json({ operations: Object.keys(operations) }));
  app.post("/operations/:name", async (c) => {
    const operation = Object.hasOwn(operations, c.req.param("name")) ? operations[c.req.param("name")] : undefined;
    if (!operation) return c.json({ error: "unknown-operation" }, 404);
    try {
      return c.json(await operation());
    } catch (error) {
      console.error(`Triggered operation ${c.req.param("name")} failed:`, error);
      return c.json({ error: "failed" }, 500);
    }
  });
  app.notFound((c) => c.json({ error: "not-found" }, 404));
  return app;
}
