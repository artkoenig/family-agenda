import { afterEach, describe, expect, it } from "vitest";
import { defaultPrograms } from "../src/services";
import { servicesFromEnvironment } from "../src/index";

describe("servicesFromEnvironment", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("throws when DATABASE_URL is not set", () => {
    delete process.env.DATABASE_URL;
    expect(() => servicesFromEnvironment(defaultPrograms, "/instance.json")).toThrow("DATABASE_URL is not set");
  });

  it("returns the defaults for unset variables", () => {
    process.env.DATABASE_URL = "postgres://dbhost:5433/synapse";
    delete process.env.MATRIX_DATA_DIRECTORY;
    delete process.env.MATRIX_HOST;
    delete process.env.MATRIX_SERVER_NAME;

    const services = servicesFromEnvironment(defaultPrograms, "/instance.json");

    expect(services).toEqual({
      programs: defaultPrograms,
      databaseUrl: "postgres://dbhost:5433/synapse",
      dataDirectory: "/var/lib/family-agenda/matrix-data",
      instanceFile: "/instance.json",
      host: "worker",
      serverName: "family-agenda.local",
      ports: { synapse: 8008, bridges: { whatsapp: 29318 } },
      database: { host: "dbhost", port: 5433, name: "synapse", user: "synapse" },
    });
  });

  it("uses the environment values when set", () => {
    process.env.DATABASE_URL = "postgres://myhost/mydb";
    process.env.MATRIX_DATA_DIRECTORY = "/custom/data";
    process.env.MATRIX_HOST = "myhost";
    process.env.MATRIX_SERVER_NAME = "custom.local";

    const services = servicesFromEnvironment(defaultPrograms, "/custom/instance.json");

    expect(services.dataDirectory).toBe("/custom/data");
    expect(services.host).toBe("myhost");
    expect(services.serverName).toBe("custom.local");
    expect(services.instanceFile).toBe("/custom/instance.json");
  });

  it("defaults the database port to 5432 when the URL has none", () => {
    process.env.DATABASE_URL = "postgres://dbhost/synapse";

    const services = servicesFromEnvironment(defaultPrograms, "/instance.json");

    expect(services.database.port).toBe(5432);
  });
});
