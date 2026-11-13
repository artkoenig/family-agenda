import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  catalogueEntriesRequestSchema,
  contractVersion,
  descriptionSchema,
  endpoints,
  errorSchema,
  limits,
  loadProblem,
  parseContractVersion,
  pollRequestSchema,
  pollResponseSchema,
} from "../src";
import { describeOpenApi } from "../src/openapi";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const context = {
  config: { plain: { url: "https://example.org/cal.ics" }, secrets: { password: "s3cret" } },
  syncCursor: null,
  now: "2026-11-09T10:00:00.000Z",
  timeZone: "Europe/Berlin",
  egressProxy: "http://ticket:abc.def@plugin-ics-egress:3128",
};

describe("the contract version", () => {
  it("is major.minor", () => {
    expect(contractVersion).toMatch(/^\d+\.\d+$/);
    expect(parseContractVersion("1.4")).toEqual({ major: 1, minor: 4 });
  });

  it("refuses anything that is not major.minor", () => {
    for (const text of ["1", "1.2.3", "a.b", "", "1.-2"]) expect(parseContractVersion(text)).toBeNull();
  });
});

describe("whether the core loads a plugin", () => {
  it("loads a plugin of the same major whose minor is not newer than its own", () => {
    expect(loadProblem("1.0", "1.2")).toBeNull();
    expect(loadProblem("1.2", "1.2")).toBeNull();
  });

  it("refuses a plugin of a newer minor, naming both versions", () => {
    expect(loadProblem("1.3", "1.2")).toBe("built for plugin contract 1.3, but the core implements 1.2");
  });

  it("refuses a plugin of another major, older or newer", () => {
    expect(loadProblem("0.9", "1.2")).toBe("built for plugin contract 0.9, but the core implements 1.2");
    expect(loadProblem("2.0", "1.2")).toBe("built for plugin contract 2.0, but the core implements 1.2");
  });

  it("refuses a version that is no major.minor", () => {
    expect(loadProblem("1.2.0", "1.2")).toBe('"1.2.0" is no plugin contract version like 1.0');
  });

  it("compares with the core's own version by default", () => {
    expect(loadProblem(contractVersion)).toBeNull();
  });
});

describe("the schemas", () => {
  it("accept a poll with decrypted secrets and the Sync Cursor, and its answer", () => {
    expect(pollRequestSchema.parse(context)).toEqual(context);
    const answer = {
      sourceRecords: [
        {
          externalId: "uid-1",
          attributes: ["main"],
          content: { kind: "stated", stated: { kind: "task", title: "Bring paint", deadline: null, description: "- Brushes\n- Apron" } },
        },
        {
          externalId: "mail-1",
          occurredAt: "2026-11-09T09:00:00.000Z",
          attributes: ["main"],
          content: { kind: "raw-message", text: "Hi", attachments: [{ filename: "a.pdf", contentType: "application/pdf", bytes: "JVBERg==" }] },
        },
      ],
      syncCursor: "token-2",
      attributes: { declared: [{ externalId: "main", name: "Calendar" }], archived: [] },
      secrets: { refreshToken: "new" },
    };
    expect(pollResponseSchema.parse(answer)).toEqual(answer);
  });

  it("refuse a poll without a time zone, a Source Record with an unknown kind of content, and and a Task title or description over its limit", () => {
    expect(pollRequestSchema.safeParse({ ...context, timeZone: undefined }).success).toBe(false);
    // Since 3.0, a call without the egress proxy of its ticket, or with one of another scheme.
    expect(pollRequestSchema.safeParse({ ...context, egressProxy: undefined }).success).toBe(false);
    expect(pollRequestSchema.safeParse({ ...context, egressProxy: "https://ticket:abc.def@plugin-ics-egress:3128" }).success).toBe(false);
    const origin = { externalId: "x", attributes: [], content: { kind: "video" } };
    expect(pollResponseSchema.safeParse({ sourceRecords: [origin], syncCursor: null }).success).toBe(false);
    const stating = (task: { title: string; description: string | null }) => ({ externalId: "x", attributes: [], content: { kind: "stated", stated: { kind: "task", deadline: null, ...task } } });
    expect(pollResponseSchema.safeParse({ sourceRecords: [stating({ title: "x".repeat(501), description: null })], syncCursor: null }).success).toBe(false);
    expect(pollResponseSchema.safeParse({ sourceRecords: [stating({ title: "Pack", description: "x".repeat(2001) })], syncCursor: null }).success).toBe(false);
    expect(pollResponseSchema.safeParse({ sourceRecords: [stating({ title: "Pack", description: "x".repeat(2000) })], syncCursor: null }).success).toBe(true);
  });

  it("describe a plugin by its Source Type id, kind and contract version", () => {
    const description = {
      contractVersion: "1.0",
      sourceTypeId: "ics",
      kind: "stateless",
      displayName: { en: "ICS calendar", de: "ICS-Kalender" },
      version: "0.1.0",
      description: "Reads a calendar.",
      needsLlm: false,
      configuration: { version: 1, fields: [{ key: "url", label: "Address", secret: false, required: true, hasChoices: false }] },
      setupSteps: [],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 900 },
      silentApplies: true,
      endpoints: { sourceAdded: false, sourceRemoved: false },
    };
    expect(descriptionSchema.parse(description)).toEqual(description);
    expect(descriptionSchema.safeParse({ ...description, kind: "shared" }).success).toBe(false);
    expect(descriptionSchema.safeParse({ ...description, sourceTypeId: "ICS Type" }).success).toBe(false);
    expect(descriptionSchema.safeParse({ ...description, contractVersion: "1.0.0" }).success).toBe(false);
  });

  it("tell a definite error from a temporary one", () => {
    expect(errorSchema.parse({ kind: "definite", message: "Wrong password" }).kind).toBe("definite");
    expect(errorSchema.safeParse({ kind: "fatal", message: "?" }).success).toBe(false);
  });
});

describe("the request for the Catalogue entries", () => {
  it("carries the egress proxy of its ticket (since 3.0)", () => {
    expect(endpoints.catalogueEntries.method).toBe("post");
    expect(catalogueEntriesRequestSchema.safeParse({ egressProxy: context.egressProxy }).success).toBe(true);
    expect(catalogueEntriesRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("the endpoints", () => {
  it("are every function of a plugin, each with its own path", () => {
    expect(Object.keys(endpoints).sort()).toEqual(
      ["catalogueEntries", "configMigration", "description", "fieldChoices", "poll", "receive", "setupProgress", "sourceAdded", "sourceAttributes", "sourceRemoved"].sort(),
    );
    const paths = Object.values(endpoints).map((endpoint) => endpoint.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("give poll and receive 60 seconds and everything else 10, with payloads up to 10 MB", () => {
    expect(endpoints.poll.timeoutMs).toBe(60_000);
    expect(endpoints.receive.timeoutMs).toBe(60_000);
    expect(endpoints.description.timeoutMs).toBe(10_000);
    expect(endpoints.fieldChoices.timeoutMs).toBe(10_000);
    expect(limits.maxPayloadBytes).toBe(10 * 1024 * 1024);
  });
});

describe("openapi.json", () => {
  const document = describeOpenApi();

  it("is an OpenAPI 3.0 document versioned with the contract", () => {
    expect(document.openapi).toBe("3.0.3");
    expect(document.info.version).toBe(contractVersion);
  });

  it("has an operation for every endpoint, answering errors with the error shape", () => {
    for (const endpoint of Object.values(endpoints)) {
      const operation = document.paths[endpoint.path]?.[endpoint.method];
      expect(operation?.operationId).toBeDefined();
      expect(operation?.responses["4XX"]).toBeDefined();
      expect(operation?.responses["5XX"]).toBeDefined();
    }
  });

  it("is what packages/plugin-contract/openapi.json holds; after a change, run `pnpm openapi` and raise contractVersion", () => {
    const written = readFileSync(here("../openapi.json"), "utf8");

    expect(written).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});
