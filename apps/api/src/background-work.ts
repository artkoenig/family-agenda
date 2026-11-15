import type { DueWork, DueWorkReport, ExtractionReport, RunReport, Retention, SecretSweep, WorkRunner } from "@family-agenda/application";

/** The pieces of work the worker runs, each one operation that runs once and returns what it did. */
export type BackgroundWork = { dueWork: DueWork; retention: Retention; secretSweep: SecretSweep };

/** Where the worker writes what went wrong: the console in the `worker` container. */
export type WorkLog = { warn(line: string): void; error(line: string, error?: unknown): void };

/** Due Sources, then Extraction: once a minute, the shortest polling interval an Admin may set. */
const dueWorkCron = "* * * * *";
/** Messages past their retention: once an hour. */
const purgeCron = "0 * * * *";
/** Secrets nothing refers to: when the worker starts, and once a day at night (ADR-0005). */
const sweepCron = "17 3 * * *";

/** Writes the Sources that failed or were refused, and the messages Extraction could not read. */
export function logDueWork(report: DueWorkReport, log: WorkLog): void {
  if (report.polled.ok) logPolled(report.polled.report, log);
  else log.error("Polling Sources failed:", report.polled.error);
  if (report.extracted.ok) logExtracted(report.extracted.report, log);
  else log.error("Extracting messages failed:", report.extracted.error);
}

function logPolled(report: RunReport, log: WorkLog): void {
  for (const failure of report.failed) {
    log.warn(`Source ${failure.sourceId} failed (${failure.kind}): ${failure.message}`);
  }
  for (const refusal of report.refused) {
    log.warn(`Source ${refusal.sourceId} named Source Attributes it never declared or had archived, so those records are refused: ${refusal.attributes.join(", ")}`);
  }
  for (const record of report.invalid) {
    log.warn(`Source ${record.sourceId} states an invalid Item for ${record.externalId}, which is not written: ${record.problems.join("; ")}`);
  }
}

function logExtracted(report: ExtractionReport, log: WorkLog): void {
  for (const failure of report.failed) {
    log.warn(`Extracting message ${failure.messageId} failed (${failure.problem}): ${failure.message}`);
  }
  for (const dropped of report.dropped) {
    log.warn(`An Item "${dropped.title ?? ""}" of message ${dropped.messageId} failed a check twice and is not written: ${dropped.problem}`);
  }
}

/** Runs `work`, writing it to the log should it fail, so that the schedule goes on. */
const logged = (work: () => Promise<unknown>, failure: string, log: WorkLog) => async (): Promise<void> => {
  try {
    await work();
  } catch (error) {
    log.error(failure, error);
  }
};

/** Gives the worker its work from schedules: due work, the purge, and the sweep on start and daily. */
export async function startBackgroundWork(app: BackgroundWork, schedule: WorkRunner, log: WorkLog): Promise<void> {
  const dueWork = async () => {
    logDueWork(await app.dueWork.run(), log);
  };
  await schedule.every("due-work", dueWorkCron, logged(dueWork, "Running due Sources and Extraction failed:", log));
  await schedule.every("purge", purgeCron, logged(() => app.retention.purge(), "Purging messages past their retention failed:", log));
  await schedule.every("secret-sweep", sweepCron, logged(() => app.secretSweep.sweep(), "Removing secrets nothing refers to failed:", log), { atStart: true });
}
