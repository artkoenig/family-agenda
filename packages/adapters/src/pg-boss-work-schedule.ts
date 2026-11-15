import type { WorkSchedule } from "@family-agenda/application";
import { PgBoss, type ConstructorOptions } from "pg-boss";

/** A run that stops sending its heartbeat, such as of a worker that died, frees its work after this. */
const heartbeatSeconds = 60;

/** The longest a run may take before the next occurrence may start anyway. */
const expireInSeconds = 24 * 60 * 60;

/**
 * Work from pg-boss schedules. Each piece of work has a queue of its own with the `exclusive`
 * policy, which takes no job while one is queued or active: an occurrence that finds the
 * previous run still going is not sent. pg-boss sends each occurrence of a schedule once
 * across all instances on the database.
 */
export class PgBossWorkSchedule implements WorkSchedule {
  private readonly boss: PgBoss;

  constructor(options: ConstructorOptions) {
    this.boss = new PgBoss(options);
    this.boss.on("error", (error) => {
      console.error("pg-boss:", error);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async every(name: string, cron: string, run: () => Promise<void>): Promise<void> {
    await this.serve(name, run);
    await this.boss.schedule(name, cron);
  }

  async now(name: string, run: () => Promise<void>): Promise<void> {
    await this.serve(name, run);
    await this.boss.send(name);
  }

  private async serve(name: string, run: () => Promise<void>): Promise<void> {
    await this.boss.createQueue(name, { policy: "exclusive", retryLimit: 0, heartbeatSeconds, expireInSeconds });
    await this.boss.work(name, async () => {
      await run();
    });
  }
}
