import type { ActivityKind } from "@family-agenda/application";
import { acts, familyLanguages, horizonDaysRange, itemKinds, photoTypes, type RunError } from "@family-agenda/domain";
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

/** Two instants, both included; written only, as queries compare it in SQL. */
const tstzrange = customType<{ data: { from: Date; to: Date }; driverData: string }>({
  dataType: () => "tstzrange",
  toDriver: ({ from, to }) => `[${from.toISOString()},${to.toISOString()}]`,
});

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

/** The settings of the Instance's one Family; its one row is created with the schema. */
export const settings = pgTable(
  "settings",
  {
    id: singleRowId(),
    recoveryKitConfirmedAt: timestamptz("recovery_kit_confirmed_at"),
    /** The Family Language, `en` or `de`, which dates are formatted in. */
    language: text("language").notNull().default("en"),
    /** The Tesseract codes OCR reads in, in order; by default the one of the Family Language. */
    ocrLanguages: text("ocr_languages").array().notNull().default(sql`'{eng}'::text[]`),
  },
  (table) => [
    singleRow("settings", table.id),
    oneOf("settings_language_known", table.language, familyLanguages),
    check("settings_ocr_languages_not_empty", sql`cardinality(${table.ocrLanguages}) > 0`),
  ],
);

export const admins = pgTable("admins", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamptz("created_at").notNull(),
});

/** Sessions by the SHA-256 of their token, so that a leaked table signs no one in. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [index("admin_sessions_admin_id_idx").on(table.adminId), index("admin_sessions_expires_at_idx").on(table.expiresAt)],
);

export const signInFailures = pgTable(
  "sign_in_failures",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    key: text("key").notNull(),
    at: timestamptz("at").notNull(),
  },
  (table) => [index("sign_in_failures_key_at_idx").on(table.key, table.at)],
);

/**
 * Envelope-encrypted secrets (ADR-0006); the master key that unwraps them is not in Postgres.
 * Sources and the LLM endpoint refer to them by id without a foreign key, as the SecretStore is a
 * port of its own; secrets no one refers to are swept.
 */
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey(),
  wrappedDataKey: bytea("wrapped_data_key").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const familyMembers = pgTable(
  "family_members",
  {
    id: uuid("id").primaryKey(),
    /** The order Family Members were added in, which lists and quick filters keep. */
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    /** The photo in the BlobStore, if any, and its image format. */
    photoBlob: text("photo_blob"),
    photoContentType: text("photo_content_type"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check("family_members_photo_complete", allOrNone(table.photoBlob, table.photoContentType)),
    oneOf("family_members_photo_content_type_known", table.photoContentType, photoTypes),
  ],
);

export const views = pgTable(
  "views",
  {
    id: uuid("id").primaryKey(),
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    horizonDays: integer("horizon_days").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "views_horizon_days_in_range",
      sql`${table.horizonDays} BETWEEN ${sql.raw(String(horizonDaysRange.min))} AND ${sql.raw(String(horizonDaysRange.max))}`,
    ),
  ],
);

/** A View's preselected Family Members; removing a Family Member removes them here too. */
export const viewPreselections = pgTable(
  "view_preselections",
  {
    viewId: uuid("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.viewId, table.familyMemberId] }),
    index("view_preselections_family_member_id_idx").on(table.familyMemberId),
  ],
);

/**
 * Per Source Type id, whether an Admin enabled it and when it was discovered (ADR-0010). A row is
 * never removed, so that a Source keeps its Source Type while the plugin is not installed.
 */
export const sourceTypes = pgTable("source_types", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** The application version the Source Type was first discovered in. */
  firstSeenIn: text("first_seen_in").notNull(),
  firstSeenAt: timestamptz("first_seen_at").notNull(),
  /** Until an Admin opens the list of Source Types. */
  isNew: boolean("is_new").notNull().default(true),
});

/**
 * Per entry of a Source Type's catalogue, such as a Messenger of the Matrix plugin, whether an
 * Admin enabled it and when it was discovered (ADR-0011).
 */
export const catalogueEntries = pgTable(
  "catalogue_entries",
  {
    sourceTypeId: text("source_type_id")
      .notNull()
      .references(() => sourceTypes.id),
    entryId: text("entry_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** The application version the entry was first discovered in. */
    firstSeenIn: text("first_seen_in").notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    /** How often the Sources using it are polled; null for their plugin's suggestion. */
    pollIntervalSeconds: integer("poll_interval_seconds"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceTypeId, table.entryId] }),
    check("catalogue_entries_poll_interval_positive", sql`${table.pollIntervalSeconds} > 0`),
  ],
);

/**
 * Sources of every Source Type, so that a new one needs no migration. A Source keeps its
 * Source Type id even when the plugin is removed, and resumes once it is installed again.
 * Removing a Source removes everything it brought in, down to the Revisions, by cascade.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    sourceTypeId: text("source_type_id")
      .notNull()
      .references(() => sourceTypes.id),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    configVersion: integer("config_version").notNull(),
    /** The SecretStore references of the secret fields, by field key. */
    secretRefs: jsonb("secret_refs").$type<Record<string, string>>().notNull(),
    /** The plugin's opaque state, handed back on its next run. */
    state: text("state"),
    /** As an Admin set it; null for the plugin's suggestion. */
    pollIntervalSeconds: integer("poll_interval_seconds"),
    /** Whether its Items show on the timeline; a hidden Source is still read. */
    shown: boolean("shown").notNull().default(true),
    /** As an Admin named it; null for the name the Admin area derives from its settings. */
    name: text("name"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("sources_source_type_id_idx").on(table.sourceTypeId),
    check("sources_poll_interval_positive", sql`${table.pollIntervalSeconds} > 0`),
  ],
);

/** How a Source's runs went, one row per Source, apart from what an Admin configures. */
export const sourceHealth = pgTable(
  "source_health",
  {
    sourceId: uuid("source_id")
      .primaryKey()
      .references(() => sources.id, { onDelete: "cascade" }),
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
    check("source_health_failure_complete", allOrNone(table.failingSince, table.lastErrorKind, table.lastError)),
    oneOf("source_health_last_error_kind_known", table.lastErrorKind, ["definite", "temporary"] satisfies RunError["kind"][]),
  ],
);

/**
 * The Family Members a Source is assigned to, whom its Items concern; a Source with none here
 * concerns the whole Family. Removing the Source or the Family Member removes them here too.
 */
export const sourceMembers = pgTable(
  "source_members",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.familyMemberId] }),
    index("source_members_family_member_id_idx").on(table.familyMemberId),
  ],
);

/** Appearances of Items in Sources (ADR-0009). */
export const origins = pgTable(
  "origins",
  {
    id: uuid("id").primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** The Origin's id within its Source, such as a calendar entry's UID. */
    externalId: text("external_id").notNull(),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull(),
    link: text("link"),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    /**
     * When the Source said the Origin was deleted, such as a redacted message: its raw message is
     * gone and its Revisions are rejected, and it never comes back.
     */
    withdrawnAt: timestamptz("withdrawn_at"),
  },
  (table) => [unique("origins_source_external_id_unique").on(table.sourceId, table.externalId)],
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
    window: tstzrange("window"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("items_window_idx").using("gist", table.window),
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
    originId: uuid("origin_id")
      .notNull()
      .references(() => origins.id, { onDelete: "cascade" }),
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
    check("revisions_rejection_only_when_rejected", sql`${table.rejection} IS NULL OR NOT ${table.accepted}`),
  ],
);

/**
 * Messages to extract Items from, at most one per Origin, which also identifies it. Their text and
 * attachments are files in the BlobStore; Postgres keeps only where they are and a hash of them
 * (ADR-0006).
 */
export const rawMessages = pgTable(
  "raw_messages",
  {
    originId: uuid("origin_id")
      .primaryKey()
      .references(() => origins.id, { onDelete: "cascade" }),
    /** The conversation within the Source, such as a mail thread. */
    thread: text("thread"),
    sentAt: timestamptz("sent_at").notNull(),
    textBlob: text("text_blob").notNull(),
    textSha256: text("text_sha256").notNull(),
    textSize: integer("text_size").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    /** When it was extracted successfully, which happens once (ADR-0009); null while it waits. */
    extractedAt: timestamptz("extracted_at"),
  },
  (table) => [
    index("raw_messages_pending_idx").on(table.receivedAt).where(sql`${table.extractedAt} IS NULL`),
    index("raw_messages_thread_idx").on(table.thread),
    check("raw_messages_text_size_not_negative", sql`${table.textSize} >= 0`),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    rawMessageId: uuid("raw_message_id")
      .notNull()
      .references(() => rawMessages.originId, { onDelete: "cascade" }),
    /** Its place among the message's attachments. */
    position: integer("position").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    blob: text("blob").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    /** Why it could not be turned into text when its message was extracted; null if it could, or was not read. */
    conversionProblem: text("conversion_problem"),
  },
  (table) => [
    primaryKey({ columns: [table.rawMessageId, table.position] }),
    check("message_attachments_position_not_negative", sql`${table.position} >= 0`),
    check("message_attachments_size_not_negative", sql`${table.size} >= 0`),
  ],
);

/** The Family's one LLM endpoint; its API key is in the SecretStore. */
export const llmEndpoints = pgTable(
  "llm_endpoints",
  {
    id: singleRowId(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    apiKeyRef: text("api_key_ref"),
    /** Whether its model reads images, so that scanned pages are sent to it rather than to OCR. */
    vision: boolean("vision").notNull().default(false),
    /** When an Admin acknowledged that third parties' messages are sent to it; null for a local one. */
    acknowledgedAt: timestamptz("acknowledged_at"),
    savedAt: timestamptz("saved_at").notNull(),
  },
  (table) => [singleRow("llm_endpoints", table.id)],
);

/** What the worker is busy with, one row while it is; read by the api for the Views. */
export const backgroundActivities = pgTable(
  "background_activities",
  {
    id: singleRowId(),
    kind: text("kind").notNull(),
    done: integer("done").notNull(),
    total: integer("total").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    singleRow("background_activities", table.id),
    oneOf("background_activities_kind_known", table.kind, ["polling", "extracting"] satisfies ActivityKind[]),
    check("background_activities_progress", sql`0 <= ${table.done} AND ${table.done} <= ${table.total}`),
  ],
);
