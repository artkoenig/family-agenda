import type { JobQueue } from "@family-butler/application";
import { PgBoss } from "pg-boss";

export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly queues = new Set<string>();

  constructor(databaseUrl: string) {
    this.boss = new PgBoss(databaseUrl);
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

  async send(name: string, data: object): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.send(name, data);
  }

  async work(name: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.work(name, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  private async ensureQueue(name: string): Promise<void> {
    if (this.queues.has(name)) return;
    await this.boss.createQueue(name);
    this.queues.add(name);
  }
}
