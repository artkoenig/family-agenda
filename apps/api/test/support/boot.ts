import { randomBytes } from "node:crypto";
import pg from "pg";
import { bootApplication, type Application } from "../../src/composition-root";
import { FakeClock } from "./fake-clock";

const serverUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

export type TestInstance = {
  app: Application;
  clock: FakeClock;
  close(): Promise<void>;
};

/**
 * Boots the application through the real composition root against a throwaway
 * Postgres database, with a controllable Clock.
 */
export async function bootForTest(): Promise<TestInstance> {
  const databaseName = `family_butler_test_${randomBytes(6).toString("hex")}`;
  await withServer((client) => client.query(`CREATE DATABASE ${databaseName}`));
  const databaseUrl = new URL(serverUrl);
  databaseUrl.pathname = `/${databaseName}`;

  const clock = new FakeClock(new Date("2026-09-14T07:00:00Z"));
  const app = await bootApplication({ databaseUrl: databaseUrl.toString(), clock });

  return {
    app,
    clock,
    async close() {
      await app.close();
      await withServer((client) => client.query(`DROP DATABASE ${databaseName} WITH (FORCE)`));
    },
  };
}

async function withServer(run: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
