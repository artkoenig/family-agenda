/**
 * The contract between the core and a plugin container (ADR-0001). The core calls; a plugin
 * answers. These schemas are the source of truth: `openapi.json` is generated from them, and the
 * core validates every request and response with them.
 */
import { z } from "zod";

/**
 * `major.minor`. A minor change is additive only, such as an optional field or an optional new
 * endpoint; anything else is a new major. CI compares `openapi.json` with the last release.
 */
export const contractVersion = "1.1";

export type ContractVersion = { major: number; minor: number };

export function parseContractVersion(text: string): ContractVersion | null {
  const parts = /^(\d+)\.(\d+)$/.exec(text);
  return parts === null ? null : { major: Number(parts[1]), minor: Number(parts[2]) };
}

/**
 * Why the core does not load a plugin built for `pluginVersion`, or null where it does: the same
 * major, and a minor no newer than the core's own. The core supports one major at a time.
 */
export function loadProblem(pluginVersion: string, coreVersion: string = contractVersion): string | null {
  const plugin = parseContractVersion(pluginVersion);
  if (plugin === null) return `"${pluginVersion}" is no plugin contract version like 1.0`;
  const core = parseContractVersion(coreVersion);
  if (core !== null && plugin.major === core.major && plugin.minor <= core.minor) return null;
  return `built for plugin contract ${pluginVersion}, but the core implements ${coreVersion}`;
}

export const limits = {
  /** How long the core waits for `poll` and `receive`. */
  ingestTimeoutMs: 60_000,
  /** How long the core waits for every other call. */
  callTimeoutMs: 10_000,
  /** The largest request or response body, either way. */
  maxPayloadBytes: 10 * 1024 * 1024,
} as const;

const isoInstant = z.iso.datetime({ offset: true });
const isoDay = z.iso.date();
const base64 = z.base64();

const jsonValue: z.ZodType = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
).meta({ id: "JsonValue" });
export const jsonObjectSchema = z.record(z.string(), jsonValue).meta({ id: "JsonObject" });

/** A plain text, or one per language with English always present. */
export const pluginTextSchema = z
  .union([z.string(), z.looseObject({ en: z.string() }).catchall(z.string())])
  .meta({ id: "PluginText", description: "Plain, or per language such as { en, de }; English is the fallback." });

/** The answer to a call that failed: a 4xx with `definite` needs an Admin; anything else is retried. */
export const errorSchema = z
  .object({ kind: z.enum(["definite", "temporary"]), message: z.string() })
  .meta({ id: "Error", description: "4xx with kind definite is a definite error; 5xx, a timeout or no answer is a temporary one." });

const secretsSchema = z.record(z.string(), z.string()).meta({ id: "Secrets", description: "Decrypted secret fields. A plugin MUST NOT persist them." });

export const configSchema = z.object({ plain: jsonObjectSchema, secrets: secretsSchema }).meta({ id: "SourceConfig" });

/** What every call for one Source carries, so that a stateless plugin keeps nothing between calls. */
export const runContextSchema = z
  .object({
    config: configSchema,
    /** What the plugin returned last time to resume from; null on the first run. */
    syncCursor: z.string().nullable(),
    /** The time of the run, by the Instance's clock. */
    now: isoInstant,
    /** The IANA time zone of the Family. */
    timeZone: z.string().min(1),
  })
  .meta({ id: "RunContext" });

export const configFieldSchema = z
  .object({
    key: z.string().min(1),
    label: pluginTextSchema,
    secret: z.boolean(),
    required: z.boolean(),
    description: pluginTextSchema.optional(),
    setByPlugin: z.boolean().optional(),
    /** Whether `fieldChoices` offers its values for an existing Source. */
    hasChoices: z.boolean(),
    /**
     * Whether its value is a host the plugin connects to, such as `imap.example.org` or
     * `imap.example.org:993`; the plugin's egress proxy allows it, on any port without one.
     */
    host: z.boolean().optional(),
  })
  .meta({ id: "ConfigField" });

export const setupStepSchema = z
  .object({
    id: z.string().min(1),
    title: pluginTextSchema,
    description: pluginTextSchema,
    /** Whether `setupProgress` drives it live, such as a QR code login. */
    live: z.boolean(),
  })
  .meta({ id: "SetupStep" });

const sourceTypeId = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase kebab-case");

export const descriptionSchema = z
  .object({
    contractVersion: z.string().regex(/^\d+\.\d+$/, "major.minor"),
    sourceTypeId,
    /** Stateless: every call carries all it needs, any number of replicas. Singleton: state of its own, exactly one replica. */
    kind: z.enum(["stateless", "singleton"]),
    displayName: pluginTextSchema,
    /** The plugin's own version. */
    version: z.string().min(1),
    /** What the Admin area says about the Source Type. */
    description: pluginTextSchema,
    /** Whether its Source Records are messages the LLM reads. */
    needsLlm: z.boolean(),
    /** Shown before an Admin enables it, such as for an unofficial client. */
    riskNotice: pluginTextSchema.optional(),
    configuration: z.object({
      /** Raised whenever the plain configuration changes shape, from 1; `configMigration` goes one version up. */
      version: z.int().min(1),
      fields: z.array(configFieldSchema),
    }),
    setupSteps: z.array(setupStepSchema),
    ingestion: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("polling"), suggestedIntervalSeconds: z.int().positive() }),
      z.object({ mode: z.literal("push") }),
    ]),
    /** Whether a Source of this type counts as Silent when no Source Records arrive for a while. */
    silentApplies: z.boolean(),
    /** What an Admin enables one by one, such as Messengers; its entries come from `catalogueEntries`. */
    catalogue: z.object({ title: pluginTextSchema, configKey: z.string().min(1) }).optional(),
    /** Which optional endpoints the plugin implements. */
    endpoints: z.object({ sourceAdded: z.boolean(), sourceRemoved: z.boolean() }),
  })
  .meta({ id: "Description" });

/** The longest text an Item of each kind keeps; a longer one is refused. */
export const statedTextLimits = { event: 500, lesson: 200, task: 500 } as const;
const text = (limit: number) => z.string().max(limit);

const span = z.object({ allDay: z.literal(false), start: isoInstant, end: isoInstant });

export const statedItemSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("event"),
      title: text(statedTextLimits.event),
      span: z.union([span, z.object({ allDay: z.literal(true), firstDay: isoDay, lastDay: isoDay })]),
      place: text(statedTextLimits.event).nullable(),
      cancelled: z.boolean(),
    }),
    z.object({
      kind: z.literal("lesson"),
      subject: text(statedTextLimits.lesson),
      span,
      room: text(statedTextLimits.lesson).nullable(),
      teacher: text(statedTextLimits.lesson).nullable(),
      change: z.enum(["cancellation", "substitution", "room-change"]).nullable(),
      previousRoom: text(statedTextLimits.lesson).nullable(),
      previousTeacher: text(statedTextLimits.lesson).nullable(),
      note: text(statedTextLimits.lesson).nullable(),
    }),
    z.object({ kind: z.literal("task"), title: text(statedTextLimits.task), deadline: isoDay.nullable(), bring: z.array(text(statedTextLimits.task)).max(50) }),
  ])
  .meta({ id: "StatedItem" });

export const sourceRecordSchema = z
  .object({
    externalId: z.string().min(1),
    occurredAt: isoInstant.optional(),
    /** External ids of declared Source Attributes. */
    attributes: z.array(z.string().min(1)),
    sender: z.string().optional(),
    subject: z.string().optional(),
    link: z.url({ protocol: /^https?$/ }).optional(),
    content: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("raw-message"),
        text: z.string(),
        attachments: z.array(z.object({ filename: z.string(), contentType: z.string(), bytes: base64 })),
      }),
      z.object({ kind: z.literal("stated"), stated: statedItemSchema }),
    ]),
  })
  .meta({ id: "SourceRecord" });

export const ingestResultSchema = z
  .object({
    sourceRecords: z.array(sourceRecordSchema),
    /** Where the next run resumes; stored only together with these Source Records. */
    syncCursor: z.string().nullable(),
    /** External ids of Source Records deleted in the Source since. */
    withdrawn: z.array(z.string()).optional(),
    /** Source Attributes to declare (idempotent) and archive, applied before the Source Records. */
    attributes: z
      .object({
        declared: z.array(z.object({ externalId: z.string().min(1), name: z.string() })),
        archived: z.array(z.string()),
      })
      .optional(),
    /** Secrets the plugin changed, such as a refreshed token; the core stores them encrypted. */
    secrets: secretsSchema.optional(),
  })
  .meta({ id: "IngestResult" });

export const pollRequestSchema = runContextSchema;
export const pollResponseSchema = ingestResultSchema;
export const receiveRequestSchema = z.object({ context: runContextSchema, payload: base64 }).meta({ id: "ReceiveRequest" });
export const sourceAddedRequestSchema = runContextSchema.omit({ syncCursor: true }).meta({ id: "SourceAddedRequest" });
export const sourceAddedResponseSchema = configSchema.meta({ id: "SourceAddedResponse", description: "Values of the fields set by the plugin." });
export const fieldChoicesRequestSchema = z.object({ field: z.string().min(1), context: runContextSchema }).meta({ id: "FieldChoicesRequest" });
export const fieldChoicesResponseSchema = z
  .object({ choices: z.array(z.object({ value: z.string(), label: z.string() })) })
  .meta({ id: "FieldChoicesResponse" });
export const catalogueEntriesResponseSchema = z
  .object({
    entries: z.array(
      z.object({
        id: z.string().min(1),
        displayName: pluginTextSchema,
        description: pluginTextSchema,
        installed: z.boolean(),
        riskNotice: pluginTextSchema.optional(),
      }),
    ),
  })
  .meta({ id: "CatalogueEntriesResponse" });
export const setupProgressRequestSchema = z.object({ stepId: z.string().min(1), context: runContextSchema }).meta({ id: "SetupProgressRequest" });
export const setupProgressResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("waiting"), qrCode: z.string().optional(), message: pluginTextSchema.optional() }),
    z.object({ status: z.literal("done"), message: pluginTextSchema.optional() }),
    z.object({ status: z.literal("failed"), message: pluginTextSchema }),
  ])
  .meta({ id: "SetupProgress" });
export const configMigrationRequestSchema = z
  .object({ fromVersion: z.int().min(1), plain: jsonObjectSchema })
  .meta({ id: "ConfigMigrationRequest", description: "Turns the plain configuration of fromVersion into that of fromVersion + 1." });
export const configMigrationResponseSchema = z.object({ plain: jsonObjectSchema }).meta({ id: "ConfigMigrationResponse" });

export type Endpoint = {
  method: "get" | "post";
  path: string;
  summary: string;
  timeoutMs: number;
  request?: z.ZodType;
  /** No response schema: the plugin answers 204. */
  response?: z.ZodType;
};

/** Every function of a plugin, one endpoint each. */
export const endpoints = {
  description: {
    method: "get",
    path: "/description",
    summary: "Describes the plugin; fetched uncached.",
    timeoutMs: limits.callTimeoutMs,
    response: descriptionSchema,
  },
  poll: {
    method: "post",
    path: "/poll",
    summary: "Polls one Source.",
    timeoutMs: limits.ingestTimeoutMs,
    request: pollRequestSchema,
    response: pollResponseSchema,
  },
  receive: {
    method: "post",
    path: "/receive",
    summary: "Ingests a payload pushed to the core for one Source.",
    timeoutMs: limits.ingestTimeoutMs,
    request: receiveRequestSchema,
    response: ingestResultSchema,
  },
  sourceAdded: {
    method: "post",
    path: "/sources/added",
    summary: "Prepares a Source an Admin adds; a definite error refuses it.",
    timeoutMs: limits.callTimeoutMs,
    request: sourceAddedRequestSchema,
    response: sourceAddedResponseSchema,
  },
  sourceRemoved: {
    method: "post",
    path: "/sources/removed",
    summary: "Cleans up after a Source was removed; a failure is ignored.",
    timeoutMs: limits.callTimeoutMs,
    request: runContextSchema,
  },
  fieldChoices: {
    method: "post",
    path: "/field-choices",
    summary: "The values a choice field offers for an existing Source.",
    timeoutMs: limits.callTimeoutMs,
    request: fieldChoicesRequestSchema,
    response: fieldChoicesResponseSchema,
  },
  catalogueEntries: {
    method: "get",
    path: "/catalogue/entries",
    summary: "Every Catalogue entry and whether it is installed.",
    timeoutMs: limits.callTimeoutMs,
    response: catalogueEntriesResponseSchema,
  },
  setupProgress: {
    method: "post",
    path: "/setup-steps/progress",
    summary: "What a live setup step shows now.",
    timeoutMs: limits.callTimeoutMs,
    request: setupProgressRequestSchema,
    response: setupProgressResponseSchema,
  },
  configMigration: {
    method: "post",
    path: "/config-migration",
    summary: "Migrates a plain configuration one version up.",
    timeoutMs: limits.callTimeoutMs,
    request: configMigrationRequestSchema,
    response: configMigrationResponseSchema,
  },
} as const satisfies Record<string, Endpoint>;

export type RunContext = z.infer<typeof runContextSchema>;
export type Description = z.infer<typeof descriptionSchema>;
export type IngestResult = z.infer<typeof ingestResultSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type PluginError = z.infer<typeof errorSchema>;

export type EndpointName = keyof typeof endpoints;
/** What an endpoint answers once validated; undefined for one that answers 204. */
export type EndpointResponse<N extends EndpointName> = (typeof endpoints)[N] extends { response: infer S extends z.ZodType } ? z.infer<S> : undefined;
