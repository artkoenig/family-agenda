import { describe, expect, it } from "vitest";
import {
  parseManifest,
  problemsWith,
  problemsWithOrigin,
  sdkVersion,
  SourceError,
  type Origin,
  type SourcePlugin,
} from "../src";
import { describeSourcePluginContract } from "../src/testing";

const examplePlugin = (overrides: Partial<SourcePlugin> = {}): SourcePlugin => ({
  identity: { sourceTypeId: "example", displayName: "Example", version: "1.0.0", sdkVersion },
  configuration: {
    version: 2,
    fields: [
      { key: "url", label: "URL", secret: false, required: true },
      { key: "password", label: "Password", secret: true, required: true },
    ],
    migrations: { 1: (plain) => ({ url: plain.address ?? null }) },
  },
  setupSteps: [],
  ingestion: {
    mode: "polling",
    suggestedIntervalSeconds: 900,
    poll: ({ state }) =>
      Promise.resolve({
        origins: [
          {
            externalId: "mail-1",
            occurredAt: new Date("2026-09-14T07:00:00Z"),
            attributes: { sender: "school@example.org" },
            content: { kind: "raw-message", text: "Trip on Friday", attachments: [] },
          },
        ],
        state: `${state ?? ""}+1`,
      }),
  },
  originAttributes: [
    { key: "sender", label: "Sender", knownValues: () => Promise.resolve([]) },
  ],
  health: { silentApplies: true },
  ...overrides,
});

describeSourcePluginContract(() => examplePlugin(), {
  config: { plain: { url: "https://example.org" }, secrets: { password: "secret" } },
});

describe("a plugin that is not loadable", () => {
  it("says why", () => {
    expect(
      problemsWith(
        examplePlugin({
          identity: { sourceTypeId: "Example Type", displayName: "Example", version: "1.0.0", sdkVersion: "9.0.0" },
        }),
      ),
    ).toEqual([
      'Source Type id "Example Type" is not lowercase kebab-case',
      `built for SDK 9.0.0, but this is SDK ${sdkVersion}`,
    ]);
  });

  it("names configuration fields used twice and migrations that are missing", () => {
    const plugin = examplePlugin({
      configuration: {
        version: 3,
        fields: [
          { key: "url", label: "URL", secret: false, required: true },
          { key: "url", label: "Address", secret: true, required: false },
        ],
        migrations: { 2: (plain) => plain },
      },
    });

    expect(problemsWith(plugin)).toEqual([
      'configuration field "url" is declared twice',
      "no configuration migration from version 1",
    ]);
  });

  it("refuses a polling interval that is not positive", () => {
    const plugin = examplePlugin({
      ingestion: { mode: "polling", suggestedIntervalSeconds: 0, poll: () => Promise.reject(new Error("unused")) },
    });

    expect(problemsWith(plugin)).toEqual(["the suggested polling interval must be positive"]);
  });
});

describe("Origins", () => {
  const origin = (content: Origin["content"]): Origin => ({
    externalId: "1",
    occurredAt: new Date(),
    attributes: {},
    content,
  });

  it("carry a raw message or structured Revisions", () => {
    expect(problemsWithOrigin(origin({ kind: "raw-message", text: "Hi", attachments: [] }))).toEqual([]);
    expect(
      problemsWithOrigin(
        origin({
          kind: "revisions",
          revisions: [{ itemKind: "event", itemKey: "e1", action: "create", fields: { title: "Match" } }],
        }),
      ),
    ).toEqual([]);
  });

  it("need an external id and at least one Revision", () => {
    expect(
      problemsWithOrigin({ ...origin({ kind: "revisions", revisions: [] }), externalId: "" }),
    ).toEqual(["the Origin has no external id", "the Origin carries no Revisions"]);
  });
});

describe("errors", () => {
  it("are definite or temporary", () => {
    expect(new SourceError("wrong password", "definite").kind).toBe("definite");
    expect(SourceError.temporary("timeout").kind).toBe("temporary");
  });
});

describe("a manifest", () => {
  const packageJson = (sourcePlugin: unknown) => ({
    name: "family-butler-source-example",
    version: "1.2.0",
    familyButler: { sourcePlugin },
  });

  it("is read from package.json, with the package version as the plugin's", () => {
    expect(
      parseManifest(
        packageJson({
          entry: "./src/index.ts",
          sourceTypeId: "example",
          displayName: "Example",
          sdkVersion,
          description: "Reads examples.",
          needsLlm: true,
          riskNotice: "Against the terms of service.",
        }),
      ),
    ).toEqual({
      ok: true,
      manifest: {
        entry: "./src/index.ts",
        identity: { sourceTypeId: "example", displayName: "Example", version: "1.2.0", sdkVersion },
        description: "Reads examples.",
        needsLlm: true,
        riskNotice: "Against the terms of service.",
      },
    });
  });

  it("is absent from packages that are no Source plugin", () => {
    expect(parseManifest({ name: "something-else" })).toEqual({ ok: false, problem: "no-manifest" });
  });

  it("says what is missing", () => {
    expect(parseManifest(packageJson({ sourceTypeId: "example" }))).toEqual({
      ok: false,
      problem: "invalid-manifest",
      sourceTypeId: "example",
      details: ["entry is missing", "displayName is missing", "sdkVersion is missing", "description is missing"],
    });
  });
});
