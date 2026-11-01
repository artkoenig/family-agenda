import type { ActivityKind } from "@family-agenda/application";
import { acts, familyLanguages, horizonDaysRange, itemKinds, photoTypes, agendaKinds, type RunError } from "@family-agenda/domain";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/**
 * The key of a table that holds at most one row, as an Instance serves exactly one Family
 * (ADR-0013); together with `singleRow`, it can only be `true`.
 */
const singleRowId = () => boolean("id").primaryKey().default(true);

const singleRow = (name: string, id: AnyPgColumn) => check(`${name}_single_row`, sql`${id}`);

/** Allows only the given values in the column, as a check rather than an enum type, to change easily. */
const oneOf = (name: string, column: AnyPgColumn, values: readonly string[]) =>
  check(name, sql`${column} IN (${sql.join(values.map((value) => sql.raw(`'${value}'`)), sql`, `)})`);

/** Whether all the columns are null, or none is. */
const allOrNone = (...columns: AnyPgColumn[]): SQL =>
  sql.join(
    columns.slice(1).map((column) => sql`((${columns[0]} IS NULL) = (${column} IS NULL))`),
    sql` AND `,
  );

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * What belongs to the Instance's one Family itself, as there is no Family id (ADR-0013); its one
 * row is created with the schema.
 */
export const family = pgTable(
  "family",
  {
    id: singleRowId(),
    recoveryKitConfirmedAt: timestamptz("recovery_kit_confirmed_at"),
    /** The Family Language, `en` or `de`, which dates are formatted in. */
    language: text("language").notNull().default("en"),
    /** The Tesseract codes OCR reads in, in order; by default the one of the Family Language. */
    ocrLanguages: text("ocr_languages").array().notNull().default(sql`'{eng}'::text[]`),
    /** Whether OCR reads the scanned pages of attachments; the LLM only ever receives text. */
    ocrEnabled: boolean("ocr_enabled").notNull().default(true),
  },
  (table) => [
    singleRow("family", table.id),
    oneOf("family_language_known", table.language, familyLanguages),
    check("family_ocr_languages_not_empty", sql`cardinality(${table.ocrLanguages}) > 0`),
  ],
);

export const admins = pgTable("admin", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** Sessions by the SHA-256 of their token, so that a leaked table signs no one in. */
export const adminSessions = pgTable(
  "admin_session",
  {
    id: text("id").primaryKey(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [index("admin_session_admin_id_idx").on(table.adminId), index("admin_session_expires_at_idx").on(table.expiresAt)],
);

export const signInFailures = pgTable(
  "sign_in_failure",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    key: text("key").notNull(),
    at: timestamptz("at").notNull(),
  },
  (table) => [index("sign_in_failure_key_at_idx").on(table.key, table.at)],
);

/**
 * Envelope-encrypted secrets (ADR-0006); the master key that unwraps them is not in Postgres.
 * Sources and the LLM endpoint refer to them by id without a foreign key, as the SecretStore is a
 * port of its own; secrets no one refers to are swept.
 */
export const secrets = pgTable("secret", {
  id: uuid("id").primaryKey().defaultRandom(),
  wrappedDataKey: bytea("wrapped_data_key").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const familyMembers = pgTable(
  "family_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The order Family Members were added in, which lists and quick filters keep. */
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    /** The photo in the BlobStore, if any, and its image format. */
    photoBlob: text("photo_blob"),
    photoContentType: text("photo_content_type"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("family_member_photo_complete", allOrNone(table.photoBlob, table.photoContentType)),
    oneOf("family_member_photo_content_type_known", table.photoContentType, photoTypes),
  ],
);

export const agendas = pgTable(
  "agenda",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull().default("timeline"),
    horizonDays: integer("horizon_days").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    oneOf("agenda_kind_known", table.kind, agendaKinds),
    check(
      "agenda_horizon_days_in_range",
      sql`${table.horizonDays} BETWEEN ${sql.raw(String(horizonDaysRange.min))} AND ${sql.raw(String(horizonDaysRange.max))}`,
    ),
  ],
);

/** An Agenda's preselected Family Members; removing a Family Member removes them here too. */
export const agendaPreselections = pgTable(
  "agenda_preselection",
  {
    agendaId: uuid("agenda_id")
      .notNull()
      .references(() => agendas.id, { onDelete: "cascade" }),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agendaId, table.familyMemberId] }),
    index("agenda_preselection_family_member_id_idx").on(table.familyMemberId),
  ],
);

/**
 * Per discovered Source Type id, whether an Admin enabled it (ADR-0010); a newly discovered one is
 * disabled. A row is never removed, so that a Source keeps its Source Type while the plugin is not
 * installed.
 */
export const sourceTypes = pgTable("source_type", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
});

/**
 * Per discovered entry of a Source Type's catalogue, such as a Messenger of the Matrix plugin,
 * whether an Admin enabled it (ADR-0011); a newly discovered one is disabled.
 */
export const catalogueEntries = pgTable(
  "catalogue_entry",
  {
    sourceTypeId: text("source_type_id")
      .notNull()
      .references(() => sourceTypes.id),
    entryId: text("entry_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** How often the Sources using it are polled; null for their plugin's suggestion. */
    pollIntervalSeconds: integer("poll_interval_seconds"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceTypeId, table.entryId] }),
    check("catalogue_entry_poll_interval_positive", sql`${table.pollIntervalSeconds} > 0`),
  ],
);

/**
 * Sources of every Source Type, so that a new one needs no migration; only what an Admin
 * configures, as how their runs went is in `source_run` (ADR-0014). A Source keeps its Source
 * Type id even when the plugin is removed, and resumes once it is installed again. Removing a
 * Source removes everything it brought in, down to the Revisions, by cascade.
 */
export const sources = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    sourceTypeId: text("source_type_id")
      .notNull()
      .references(() => sourceTypes.id),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    configVersion: integer("config_version").notNull(),
    /** The SecretStore references of the secret fields, by field key. */
    secretRefs: jsonb("secret_refs").$type<Record<string, string>>().notNull().default({}),
    /** As an Admin set it; null for the plugin's suggestion. */
    pollIntervalSeconds: integer("poll_interval_seconds"),
    /** Whether its Items show on the timeline; a hidden Source is still read. */
    shown: boolean("shown").notNull().default(true),
    /** As an Admin named it; null for the name the Admin area derives from its settings. */
    name: text("name"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("source_source_type_id_idx").on(table.sourceTypeId),
    check("source_poll_interval_positive", sql`${table.pollIntervalSeconds} > 0`),
  ],
);

/**
 * How a Source's runs went, one row per Source, apart from what an Admin configures (ADR-0014);
 * written by every run.
 */
export const sourceRuns = pgTable(
  "source_run",
  {
    sourceId: uuid("source_id")
      .primaryKey()
      .references(() => sources.id, { onDelete: "cascade" }),
    /**
     * Where the plugin resumes, handed back on its next run; written in the same transaction as
     * the run's Origins, so that it never runs ahead of what was recorded. A JSON string, which
     * the repositories convert in SQL.
     */
    syncCursor: jsonb("sync_cursor"),
    /** When it last ran; null to run it at the next tick. */
    lastRunAt: timestamptz("last_run_at"),
    /** When it last ran successfully, which the Admin area shows. */
    lastSuccessAt: timestamptz("last_success_at"),
    /** The first failed run since the last successful one; null while it runs successfully. */
    failingSince: timestamptz("failing_since"),
    /** `definite` once any error since `failingSince` was, else `temporary`; null with `failingSince`. */
    lastErrorKind: text("last_error_kind"),
    /** The message of the last error; null with `failingSince`. */
    lastError: text("last_error"),
    /** When its last Origin not seen before was recorded, for the Silent status. */
    lastNewOriginAt: timestamptz("last_new_origin_at"),
  },
  (table) => [
    check("source_run_failure_complete", allOrNone(table.failingSince, table.lastErrorKind, table.lastError)),
    oneOf("source_run_last_error_kind_known", table.lastErrorKind, ["definite", "temporary"] satisfies RunError["kind"][]),
  ],
);

/**
 * The Family Members a Source is assigned to, whom its Items concern; a Source with none here
 * concerns the whole Family. Removing the Source or the Family Member removes them here too. A
 * row with a `part` assigns that Part of the Source, such as a mail folder, on its own; the empty
 * `part` is the Source itself.
 */
export const sourceMembers = pgTable(
  "source_members",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    part: text("part").notNull().default(""),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.part, table.familyMemberId] }),
    index("source_members_family_member_id_idx").on(table.familyMemberId),
  ],
);

/**
 * What a Source delivered under one external id (ADR-0016): a message, with its text here and its
 * attachments behind the BlobStore (ADR-0006), or an entry carrying Revisions, such as a calendar
 * entry, without text. A message has a body, empty if it is only attachments, until it is withdrawn.
 */
export const sourceRecords = pgTable(
  "source_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Its id within its Source, such as a mail's Message-ID or a calendar entry's UID. */
    externalId: text("external_id").notNull(),
    /** When the Source received it, as its plugin tells. */
    occurredAt: timestamptz("occurred_at").notNull(),
    sender: text("sender"),
    subject: text("subject"),
    body: text("body"),
    /** When its message was extracted successfully; null while it waits. */
    processedAt: timestamptz("processed_at"),
    /**
     * When the Source said it no longer has it, such as a redacted message: its Revisions are
     * rejected and its message's text and attachments are gone. Arriving again clears it.
     */
    withdrawnAt: timestamptz("withdrawn_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** What the plugin tells about where it came from, shown with its message; goes with Source Attributes. */
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    /** Where the Family can look at the original, if anywhere. */
    link: text("link"),
    /** The Part of the Source it came from, such as a mail's folder; null if it has none. Goes with Source Attributes. */
    part: text("part"),
    /** The conversation within the Source a message belongs to, such as a mail thread, which extraction reads it in. */
    thread: text("thread"),
  },
  (table) => [
    unique("source_record_external_id_unique").on(table.sourceId, table.externalId),
    index("source_record_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.processedAt} IS NULL AND ${table.body} IS NOT NULL AND ${table.withdrawnAt} IS NULL`),
    index("source_record_thread_idx").on(table.sourceId, table.thread),
  ],
);

/** The attachments of a message; their bytes are files behind the BlobStore (ADR-0006). */
export const sourceRecordAttachments = pgTable(
  "source_record_attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "cascade" }),
    /** Its place among the message's attachments. */
    position: integer("position").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    blob: text("blob").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    /** Why it could not be turned into text when its message was extracted; null if it could, or was not read. */
    conversionProblem: text("conversion_problem"),
  },
  (table) => [
    unique("source_record_attachment_position_unique").on(table.recordId, table.position),
    check("source_record_attachment_position_not_negative", sql`${table.position} >= 0`),
    check("source_record_attachment_size_not_negative", sql`${table.size} >= 0`),
  ],
);

/**
 * Items as projections of their Revisions: `folded` and the window are recomputed whenever one of
 * their Revisions arrives or goes, and never written otherwise.
 */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    folded: jsonb("folded").$type<{ fields: Record<string, unknown>; cancelled: boolean }>(),
    /** Instants certainly before and after the Item's time, to find it by. */
    windowFrom: timestamptz("window_from"),
    windowTo: timestamptz("window_to"),
    /** Whether it waits for someone to act on it whatever its time, as an undone Task does. */
    outstanding: boolean("outstanding").notNull().default(false),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("items_window_idx").on(table.windowFrom, table.windowTo),
    index("items_outstanding_idx").on(table.id).where(sql`${table.outstanding}`),
    check("items_window_complete", allOrNone(table.windowFrom, table.windowTo)),
    check("items_window_ordered", sql`${table.windowFrom} <= ${table.windowTo}`),
    oneOf("items_kind_known", table.kind, itemKinds),
  ],
);

/**
 * Which Item a Source's own key for it, such as a calendar UID, belongs to. An Item stays while
 * any Source names it.
 */
export const itemKeys = pgTable(
  "item_keys",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.itemKey] }), index("item_keys_item_id_idx").on(table.itemId)],
);

/**
 * The author kinds as stored in `revisions.author`. An Agenda was called a View when they were
 * first stored, so its kind stays `view` in the database, to keep the existing rows and the CHECK
 * constraints valid without a migration.
 */
export const storedRevisionAuthors = ["origin", "view", "admin"] as const;

/** Append-only statements about Items (ADR-0009). */
export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey(),
    /** The order Revisions were received in, which decides between equal source times. */
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** Who stated it: an Origin, or an Agenda or an Admin ticking a Task (ADR-0009). */
    author: text("author").notNull().default("origin"),
    /** The Source Record that stated it, for a Revision of author `origin` only. */
    originId: uuid("origin_id").references(() => sourceRecords.id, { onDelete: "cascade" }),
    /** The Agenda it was made in; null for another author, or once the Agenda is removed, which keeps the Revision. */
    agendaId: uuid("view_id").references(() => agendas.id, { onDelete: "set null" }),
    /** The Admin who made it; null for another author, or once the Admin is removed. */
    adminId: uuid("admin_id").references(() => admins.id, { onDelete: "set null" }),
    act: text("act").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
    sourceTime: timestamptz("source_time").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    accepted: boolean("accepted").notNull(),
    /** Why it was rejected automatically, such as an evidence quote not found in its message. */
    rejection: text("rejection"),
    /** The words of its message it was extracted from; null for a structured Source. */
    evidence: text("evidence"),
    /** A hash of what the Revision states, so that a Source stating it again adds nothing. */
    fingerprint: text("fingerprint").notNull(),
  },
  (table) => [
    index("revisions_item_id_idx").on(table.itemId),
    unique("revisions_origin_fingerprint_unique").on(table.originId, table.fingerprint),
    oneOf("revisions_act_known", table.act, acts),
    oneOf("revisions_author_known", table.author, storedRevisionAuthors),
    check("revisions_origin_only_of_origin", sql`(${table.author} = 'origin') = (${table.originId} IS NOT NULL)`),
    check("revisions_view_only_of_view", sql`${table.agendaId} IS NULL OR ${table.author} = 'view'`),
    check("revisions_admin_only_of_admin", sql`${table.adminId} IS NULL OR ${table.author} = 'admin'`),
    check("revisions_rejection_only_when_rejected", sql`${table.rejection} IS NULL OR NOT ${table.accepted}`),
  ],
);

/** The Family's one LLM endpoint; its API key is in the SecretStore. */
export const llmEndpoints = pgTable(
  "llm_endpoint",
  {
    id: singleRowId(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    apiKeyRef: text("api_key_ref"),
    /** When an Admin acknowledged that third parties' messages are sent to it; null for a local one. */
    acknowledgedAt: timestamptz("acknowledged_at"),
    savedAt: timestamptz("saved_at").notNull(),
  },
  (table) => [singleRow("llm_endpoint", table.id)],
);

/** What the worker is busy with, one row while it is; read by the api for the Agendas. */
export const backgroundActivities = pgTable(
  "background_activity",
  {
    id: singleRowId(),
    kind: text("kind").notNull(),
    done: integer("done").notNull(),
    total: integer("total").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    singleRow("background_activity", table.id),
    oneOf("background_activity_kind_known", table.kind, ["polling", "extracting"] satisfies ActivityKind[]),
    check("background_activity_progress", sql`0 <= ${table.done} AND ${table.done} <= ${table.total}`),
  ],
);
