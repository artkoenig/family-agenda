import type { WorkRunner } from "@family-agenda/application";
import { PgBoss, type ConstructorOptions } from "pg-boss";

/** A run that stops sending its heartbeat, such as of a worker that died, frees its work after this. */
const heartbeatSeconds = 60;

/** The longest a run may take; one that hangs stops blocking its work after this. */
const expireInSeconds = 60 * 60;

/**
 * Work from pg-boss schedules. Each piece of work has a queue of its own with the `exclusive`
 * policy, which takes no job while one is queued or active: an occurrence that finds the
 * previous run still going is not sent. pg-boss sends each occurrence of a schedule once
 * across all instances on the database.
 */
export class PgBossWorkRunner implements WorkRunner {
  private readonly boss: PgBoss;

  constructor(options: ConstructorOptions, log: { error(line: string, error?: unknown): void }) {
    this.boss = new PgBoss(options);
    this.boss.on("error", (error) => {
      log.error("pg-boss:", error);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async every(name: string, cron: string, run: () => Promise<void>, options: { atStart?: boolean } = {}): Promise<void> {
    await this.boss.createQueue(name, { policy: "exclusive", retryLimit: 0, heartbeatSeconds, expireInSeconds });
    await this.boss.work(name, async () => {
      await run();
    });
    await this.boss.schedule(name, cron);
    // Refused (null) while a run is queued or going, such as one another worker just started.
    if (options.atStart) await this.boss.send(name);
  }
}
