import { describe, expect, it } from "vitest";
import {
  parseManifest,
  problemsWith,
  problemsWithManifest,
  problemsWithOrigin,
  sdkVersion,
  SourceError,
  clipped,
  statedTextLimits,
  type Origin,
  type SourceAttributes,
  type StatedEvent,
  type SourcePlugin,
} from "../src";
import { describeSourcePluginContract, undeclaredAttributes } from "../src/testing";

const wholeDayEvent: StatedEvent = {
  kind: "event",
  title: "Match",
  span: { allDay: true, firstDay: "2026-09-19", lastDay: "2026-09-19" },
  place: null,
  cancelled: false,
};

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
    poll: async ({ syncCursor, attributes }) => {
      await attributes.declare([{ externalId: "inbox", name: "Inbox" }]);
      return {
        origins:
          syncCursor !== null
            ? []
            : [
                {
                  externalId: "mail-1",
                  occurredAt: new Date("2026-09-14T07:00:00Z"),
                  sender: "school@example.org",
                  attributes: ["inbox"],
                  content: { kind: "raw-message", text: "Trip on Friday", attachments: [] },
                },
              ],
        syncCursor: `${syncCursor ?? ""}+1`,
      };
    },
  },
  health: { silentApplies: true },
  ...overrides,
});

describeSourcePluginContract(() => examplePlugin(), {
  config: { plain: { url: "https://example.org" }, secrets: { password: "secret" } },
});

describe("the contract's check that a plugin declares before it emits", () => {
  const emitting = (declare: (attributes: SourceAttributes) => Promise<void>, attribute = "inbox"): SourcePlugin =>
    examplePlugin({
      ingestion: {
        mode: "polling",
        suggestedIntervalSeconds: 900,
        poll: async ({ attributes }) => {
          await declare(attributes);
          return {
            origins: [{ externalId: "e1", attributes: [attribute], content: { kind: "stated", stated: wholeDayEvent } }],
            syncCursor: null,
          };
        },
      },
    });
  const config = { plain: {}, secrets: {} };

  it("passes a plugin that declares the Source Attributes its Origins name", async () => {
    expect(await undeclaredAttributes(emitting((attributes) => attributes.declare([{ externalId: "inbox", name: "Inbox" }])), config)).toEqual([]);
  });

  it("names the ids a plugin emits without declaring them, or after archiving them", async () => {
    expect(await undeclaredAttributes(emitting(() => Promise.resolve()), config)).toEqual(["inbox"]);
    const archived = emitting(async (attributes) => {
      await attributes.declare([{ externalId: "inbox", name: "Inbox" }]);
      await attributes.archive("inbox");
    });
    expect(await undeclaredAttributes(archived, config)).toEqual(["inbox"]);
  });

  it("lets a plugin declare an archived one again", async () => {
    const revived = emitting(async (attributes) => {
      await attributes.declare([{ externalId: "inbox", name: "Inbox" }]);
      await attributes.archive("inbox");
      await attributes.declare([{ externalId: "inbox", name: "Inbox, renamed" }]);
    });
    expect(await undeclaredAttributes(revived, config)).toEqual([]);
  });
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

  it("names a secret choice, and a catalogue without a plain field an Admin sets", () => {
    const plugin = examplePlugin({
      configuration: {
        version: 1,
        fields: [
          { key: "chats", label: "Chats", secret: true, required: false, choices: () => Promise.resolve([]) },
          { key: "account", label: "Account", secret: false, required: true, setByPlugin: true },
        ],
      },
      catalogue: { title: "Messengers", configKey: "account", entries: () => Promise.resolve([]) },
    });

    expect(problemsWith(plugin)).toEqual([
      'configuration field "chats" is a choice, so it cannot be secret',
      'the catalogue\'s field "account" is no plain field an Admin sets',
    ]);
  });
});

describe("a plugin with a catalogue", () => {
  describeSourcePluginContract(
    () =>
      examplePlugin({
        configuration: { version: 1, fields: [{ key: "messenger", label: { en: "Messenger", de: "Messenger" }, secret: false, required: true }] },
        catalogue: {
          title: { en: "Messengers", de: "Messenger" },
          configKey: "messenger",
          entries: () =>
            Promise.resolve([
              {
                id: "chat",
                displayName: { en: "Chat", de: "Chat" },
                description: { en: "Reads chats.", de: "Liest Chats." },
                installed: true,
                riskNotice: { en: "Risky.", de: "Riskant." },
              },
            ]),
        },
        identity: { sourceTypeId: "example", displayName: { en: "Example", de: "Beispiel" }, version: "1.0.0", sdkVersion },
      }),
    { languages: ["de"] },
  );
});

describe("Origins", () => {
  const origin = (content: Origin["content"]): Origin => ({
    externalId: "1",
    occurredAt: new Date(),
    attributes: ["inbox"],
    content,
  });

  const event = wholeDayEvent;

  it("carry a raw message or a stated Item", () => {
    expect(problemsWithOrigin(origin({ kind: "raw-message", text: "Hi", attachments: [] }))).toEqual([]);
    expect(problemsWithOrigin(origin({ kind: "stated", stated: event }))).toEqual([]);
  });

  it("state an Item without a time, but a message needs one", () => {
    const timeless = (content: Origin["content"]): Origin => ({ externalId: "1", attributes: ["inbox"], content });
    expect(problemsWithOrigin(timeless({ kind: "stated", stated: event }))).toEqual([]);
    const message = timeless({ kind: "raw-message", text: "Hi", attachments: [] });
    expect(problemsWithOrigin(message)).toEqual(["the Origin has no valid time"]);
    expect(problemsWithOrigin({ ...message, occurredAt: new Date("nonsense") })).toEqual(["the Origin has no valid time"]);
  });

  it("name Source Attribute ids, none empty and none twice; an empty list withdraws the Origin", () => {
    const message = origin({ kind: "raw-message", text: "Hi", attachments: [] });
    expect(problemsWithOrigin({ ...message, attributes: [] })).toEqual([]);
    expect(problemsWithOrigin({ ...message, attributes: ["inbox", "", "inbox"] })).toEqual([
      "the Origin names an empty Source Attribute id",
      'the Origin names the Source Attribute "inbox" twice',
    ]);
  });

  it("need an external id and a kind of Item a Source states", () => {
    const task = { ...event, kind: "task" } as unknown as StatedEvent;
    expect(problemsWithOrigin({ ...origin({ kind: "stated", stated: task }), externalId: "" })).toEqual([
      "the Origin has no external id",
      '"task" is no kind of Item a Source states',
    ]);
  });
});

describe("clipped texts", () => {
  it("are trimmed and cut to the limit", () => {
    expect(clipped("  Piano  ", 10)).toBe("Piano");
    expect(clipped("Piano lesson", 5)).toBe("Piano");
    expect(clipped("Piano lesson", 6)).toBe("Piano");
    expect(clipped("Piano", 5)).toBe("Piano");
    expect(statedTextLimits).toEqual({ event: 500, lesson: 200 });
  });
});

describe("Origin links", () => {
  const origin = (content: Origin["content"]): Origin => ({ externalId: "1", occurredAt: new Date(), attributes: ["inbox"], content });

  it("link only to http or https addresses", () => {
    const message = origin({ kind: "raw-message", text: "Hi", attachments: [] });
    expect(problemsWithOrigin({ ...message, link: "https://calendar.example.org/e/1" })).toEqual([]);
    expect(problemsWithOrigin({ ...message, link: "javascript:alert(1)" })).toEqual([
      "the Origin's link is no http or https address",
    ]);
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
    name: "family-agenda-source-example",
    version: "1.2.0",
    type: "module",
    familyAgenda: { sourcePlugin },
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
        esModule: true,
      },
    });
  });

  it("takes its shown texts plain or per language, with English among them", () => {
    const texts = {
      displayName: { en: "Example", de: "Beispiel" },
      description: { en: "Reads examples.", de: "Liest Beispiele." },
      riskNotice: { en: "Against the terms of service.", de: "Gegen die Nutzungsbedingungen." },
    };
    const result = parseManifest(packageJson({ entry: "./src/index.ts", sourceTypeId: "example", sdkVersion, ...texts }));
    expect(result).toMatchObject({
      ok: true,
      manifest: { identity: { displayName: texts.displayName }, description: texts.description, riskNotice: texts.riskNotice },
    });

    expect(
      parseManifest(
        packageJson({
          entry: "./src/index.ts",
          sourceTypeId: "example",
          sdkVersion,
          displayName: { de: "Beispiel" },
          description: { en: "Reads examples.", de: 7 },
        }),
      ),
    ).toEqual({
      ok: false,
      problem: "invalid-manifest",
      sourceTypeId: "example",
      details: [
        'displayName is no text: give a string, or strings by language with "en" among them',
        'description is no text: give a string, or strings by language with "en" among them',
      ],
    });
  });

  it("makes a plugin not loadable unless it is an ES module", () => {
    const manifest = (entry: string, type?: string) => {
      const result = parseManifest({
        version: "1.0.0",
        ...(type ? { type } : {}),
        familyAgenda: { sourcePlugin: { entry, sourceTypeId: "example", displayName: "Example", sdkVersion, description: "Reads examples." } },
      });
      if (!result.ok) throw new Error("the manifest is invalid");
      return result.manifest;
    };

    expect(problemsWithManifest(manifest("./index.js"))).toEqual([
      'the package is no ES module; set "type": "module" in its package.json',
    ]);
    expect(problemsWithManifest(manifest("./index.js", "commonjs"))).toHaveLength(1);
    expect(problemsWithManifest(manifest("./index.js", "module"))).toEqual([]);
    expect(problemsWithManifest(manifest("./index.mts"))).toEqual([]);
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
