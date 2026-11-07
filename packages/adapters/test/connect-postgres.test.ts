import { beforeEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(options: Record<string, unknown>) {
        created.push(options);
      }
      end() {
        return Promise.resolve();
      }
    },
  },
}));

const { connectPostgres } = await import("../src/postgres/database");

describe("connecting to Postgres", () => {
  beforeEach(() => {
    created.length = 0;
  });

  it("sizes the pool as asked", async () => {
    const connection = connectPostgres("postgres://db/family", { max: 2, idleTimeoutMillis: 5_000 });
    expect(created).toEqual([{ connectionString: "postgres://db/family", max: 2, idleTimeoutMillis: 5_000 }]);
    await connection.close();
  });

  it("leaves the pool at its defaults without options", async () => {
    const connection = connectPostgres("postgres://db/family");
    expect(created).toEqual([{ connectionString: "postgres://db/family" }]);
    await connection.close();
  });
});
