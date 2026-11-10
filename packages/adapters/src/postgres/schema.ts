import type { ActivityKind } from "@family-agenda/application";
import { statedItemKinds, familyLanguages, horizonDaysRange, itemKinds, photoTypes, agendaLayouts, timetableChangeKinds, type RunError } from "@family-agenda/domain";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
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
 * (ADR-0003); together with `singleRow`, it can only be `true`.
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
 * What belongs to the Instance's one Family itself, as there is no Family id (ADR-0003); its one
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
  passwordHash: text("password_hash"),
  /** The Identity Provider's `sub` for this Admin; null until they sign in through it. */
  identitySubject: text("identity_subject").unique(),
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
 * Envelope-encrypted secrets (ADR-0003); the master key that unwraps them is not in Postgres.
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
    /** The avatar colour, 1 to 8 (`memberColours`). */
    colour: integer("colour").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("family_member_colour_known", sql`${table.colour} BETWEEN 1 AND 8`),
    check("family_member_photo_complete", allOrNone(table.photoBlob, table.photoContentType)),
    oneOf("family_member_photo_content_type_known", table.photoContentType, photoTypes),
  ],
);

export const agendas = pgTable(
  "agenda",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    position: bigint("position", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    layout: text("layout").notNull().default("timeline"),
    horizonDays: integer("horizon_days").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    oneOf("agenda_layout_known", table.layout, agendaLayouts),
    check(
      "agenda_horizon_days_in_range",
      sql`${table.horizonDays} BETWEEN ${sql.raw(String(horizonDaysRange.min))} AND ${sql.raw(String(horizonDaysRange.max))}`,
    ),
  ],
);

/**
 * The Family Members an Agenda is for. No rows: it is for the whole Family and shows every Item.
 * With rows: it shows only the Items that concern at least one of them. Removing a Family Member
 * removes them here too, and the trigger `family_member_before_delete` first deletes the Agendas
 * they were the only member of, so none silently widens to the whole Family.
 */
export const agendaMembers = pgTable(
  "agenda_member",
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
    index("agenda_member_family_member_id_idx").on(table.familyMemberId),
  ],
);

/**
 * Per discovered Source Type id, whether an Admin enabled it (ADR-0001); a newly discovered one is
 * disabled. A row is never removed, so that a Source keeps its Source Type while the plugin is not
 * installed.
 */
export const sourceTypes = pgTable("source_type", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
});

/**
 * Per discovered entry of a Source Type's catalogue, such as a Messenger of the Matrix plugin,
 * whether an Admin enabled it (ADR-0002); a newly discovered one is disabled.
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
 * configures, as how their runs went is in `source_run` (ADR-0005). A Source keeps its Source
 * Type id even when the plugin is removed, and resumes once it is installed again. Removing a
 * Source removes everything it brought in, down to the Items, by cascade.
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
    /** The host of each secret host field's value, by field key, in the clear for the egress proxy. */
    secretHosts: jsonb("secret_hosts").$type<Record<string, string>>().notNull().default({}),
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
 * How a Source's runs went, one row per Source, apart from what an Admin configures (ADR-0005);
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
    lastNewRecordAt: timestamptz("last_new_record_at"),
    /**
     * A warning beside the Source Status: the external ids of Source Records whose stated Item
     * failed a check, so that no Item was written. An id leaves when its Source Record writes its
     * Item or is withdrawn.
     */
    invalidRecords: text("invalid_records").array().notNull().default(sql`'{}'::text[]`),
    /** Since when `invalid_records` has had an id; null while it has none. */
    invalidRecordsSince: timestamptz("invalid_records_since"),
    /**
     * A warning beside the Source Status: the Source Attribute ids that Source Records named
     * without their being declared or after their being archived, so that those were refused (a
     * plugin bug). The ids leave when a run refuses nothing, or when a declare covers them.
     */
    unknownAttributes: text("unknown_attributes").array().notNull().default(sql`'{}'::text[]`),
    /** Since when `unknown_attributes` has had an id; null while it has none. */
    unknownAttributesSince: timestamptz("unknown_attributes_since"),
  },
  (table) => [
    check("source_run_failure_complete", allOrNone(table.failingSince, table.lastErrorKind, table.lastError)),
    check(
      "source_run_invalid_records_complete",
      sql`(cardinality(${table.invalidRecords}) = 0) = (${table.invalidRecordsSince} IS NULL)`,
    ),
    check(
      "source_run_unknown_attributes_complete",
      sql`(cardinality(${table.unknownAttributes}) = 0) = (${table.unknownAttributesSince} IS NULL)`,
    ),
    oneOf("source_run_last_error_kind_known", table.lastErrorKind, ["definite", "temporary"] satisfies RunError["kind"][]),
  ],
);

/**
 * A subdivision of a Source that its plugin reports (ADR-0005), such as a mail folder, a chat or a
 * child of a school account. Written only through the plugin's port, never by the core on its own:
 * `declare` inserts one, or renames a known one and revives it, keeping its assignment, and
 * `archive` sets `archived_at`. Rows are archived, never deleted, except with their Source.
 */
export const sourceAttributes = pgTable(
  "source_attribute",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Its id within its Source, as its plugin names it. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [unique("source_attribute_external_id_unique").on(table.sourceId, table.externalId)],
);

/**
 * The only place where Family Members are assigned. A Source Attribute with no rows is assigned to
 * the whole Family. Removing the Source Attribute or the Family Member removes them here too.
 */
export const sourceAttributeMembers = pgTable(
  "source_attribute_member",
  {
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => sourceAttributes.id, { onDelete: "cascade" }),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.attributeId, table.familyMemberId] }),
    index("source_attribute_member_family_member_id_idx").on(table.familyMemberId),
  ],
);

/**
 * What a Source delivered under one external id (ADR-0005): a message, with its text here and its
 * attachments behind the BlobStore (ADR-0003), or a calendar or timetable entry, without text. A message has a body, empty if it is only attachments, until it is withdrawn.
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
    /** When the Source received a message, as its plugin tells; null for a stated Item. */
    occurredAt: timestamptz("occurred_at"),
    sender: text("sender"),
    subject: text("subject"),
    body: text("body"),
    /**
     * The Item a calendar or timetable entry states, as its plugin states it, such as
     * `{ "kind": "event", "title": ... }`, which the core writes without the LLM; null for a message.
     */
    stated: jsonb("stated").$type<Record<string, unknown>>(),
    /** When its message was extracted, or its stated Item written; null while it waits, or if it was invalid. */
    processedAt: timestamptz("processed_at"),
    /**
     * When the Source said it no longer has it, such as a redacted message: its Items are deleted
     * and its message's text and attachments are gone. Arriving again clears it.
     */
    withdrawnAt: timestamptz("withdrawn_at"),
    /**
     * When a message's text and attachments were deleted, by withdrawal or by retention: the row
     * stays as a tombstone with `sender`, `subject` and `body` cleared. Null for a stated one.
     */
    purgedAt: timestamptz("purged_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** Where the Family can look at the original, if anywhere. */
    link: text("link"),
  },
  (table) => [
    unique("source_record_external_id_unique").on(table.sourceId, table.externalId),
    index("source_record_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.processedAt} IS NULL AND ${table.stated} IS NULL AND ${table.withdrawnAt} IS NULL AND ${table.purgedAt} IS NULL`),
    check(
      "source_record_stated_kind_known",
      sql`${table.stated} IS NULL OR ${table.stated}->>'kind' IN (${sql.raw(statedItemKinds.map((kind) => `'${kind}'`).join(", "))})`,
    ),
    // A stated Source Record carries nothing of a message; a message needs the time it came.
    check(
      "source_record_stated_is_no_message",
      sql`${table.stated} IS NULL OR (${table.sender} IS NULL AND ${table.subject} IS NULL AND ${table.body} IS NULL AND ${table.purgedAt} IS NULL AND ${table.occurredAt} IS NULL)`,
    ),
    check("source_record_message_occurred", sql`${table.stated} IS NOT NULL OR ${table.occurredAt} IS NOT NULL`),
    // A message has its text exactly until it is purged.
    check("source_record_message_has_body", sql`${table.stated} IS NOT NULL OR (${table.body} IS NULL) = (${table.purgedAt} IS NOT NULL)`),
    check(
      "source_record_purged_is_cleared",
      sql`${table.purgedAt} IS NULL OR (${table.sender} IS NULL AND ${table.subject} IS NULL AND ${table.body} IS NULL)`,
    ),
    // Retention runs over messages by age.
    index("source_record_message_occurred_at_idx").on(table.occurredAt).where(sql`${table.stated} IS NULL`),
  ],
);

/** The attachments of a message; their bytes are files behind the BlobStore (ADR-0003). */
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
 * The Source Attributes a Source Record carries (a mail under two allow-listed labels has two).
 * Emitting a Source Record again with another list replaces its rows without reading it again; an
 * empty list withdraws it. No cascade from the attribute: archiving must not unassign Items.
 */
export const sourceRecordAttributes = pgTable(
  "source_record_attribute",
  {
    recordId: uuid("record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "cascade" }),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => sourceAttributes.id),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.attributeId] }), index("source_record_attribute_attribute_id_idx").on(table.attributeId)],
);

/**
 * An Item, written from its one Source Record (ADR-0005): a message's Items are written once, a
 * calendar or timetable entry's one Item is found again through its Source Record. Its fields are
 * in the detail table of its kind; an Admin can only delete it.
 */
export const items = pgTable(
  "item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("item_id_kind_unique").on(table.id, table.kind),
    index("item_record_id_idx").on(table.recordId),
    oneOf("item_kind_known", table.kind, itemKinds),
  ],
);

/** The key of a detail table, which references its Item together with the Item's kind. */
const detailOf = (kind: (typeof itemKinds)[number]) => ({
  itemId: uuid("item_id").primaryKey(),
  kind: text("kind").notNull().default(kind),
});

const detailKey = (name: string, table: { itemId: AnyPgColumn; kind: AnyPgColumn }) =>
  foreignKey({ name: `${name}_item_fk`, columns: [table.itemId, table.kind], foreignColumns: [items.id, items.kind] }).onDelete("cascade");

/** An appointment, at a time or over whole days; a cancelled one stays shown, struck through. */
export const events = pgTable(
  "event",
  {
    ...detailOf("event"),
    title: text("title").notNull(),
    location: text("location"),
    startsAt: timestamptz("starts_at"),
    endsAt: timestamptz("ends_at"),
    firstDay: date("first_day", { mode: "string" }),
    lastDay: date("last_day", { mode: "string" }),
    cancelled: boolean("cancelled").notNull().default(false),
  },
  (table) => [
    detailKey("event", table),
    check("event_kind", sql`${table.kind} = 'event'`),
    check("event_title_length", sql`char_length(${table.title}) <= 500`),
    check("event_location_length", sql`char_length(${table.location}) <= 500`),
    check(
      "event_one_window",
      sql`(${table.startsAt} IS NOT NULL AND ${table.endsAt} IS NOT NULL AND ${table.firstDay} IS NULL AND ${table.lastDay} IS NULL) OR (${table.startsAt} IS NULL AND ${table.endsAt} IS NULL AND ${table.firstDay} IS NOT NULL AND ${table.lastDay} IS NOT NULL)`,
    ),
    check("event_time_ordered", sql`${table.endsAt} >= ${table.startsAt}`),
    check("event_days_ordered", sql`${table.lastDay} >= ${table.firstDay}`),
    index("event_starts_at_idx").on(table.startsAt, table.endsAt),
    index("event_first_day_idx").on(table.firstDay, table.lastDay),
  ],
);

/** The statuses of a Task: only ticking it makes it done. */
export const taskStatuses = ["open", "done"] as const;

/** Something to do or bring; its arrival is its Source Record's `occurred_at`. */
export const tasks = pgTable(
  "task",
  {
    ...detailOf("task"),
    title: text("title").notNull(),
    deadline: date("deadline", { mode: "string" }),
    bring: text("bring").array().notNull().default(sql`'{}'::text[]`),
    cancelled: boolean("cancelled").notNull().default(false),
    status: text("status").notNull().default("open"),
    doneAt: timestamptz("done_at"),
  },
  (table) => [
    detailKey("task", table),
    check("task_kind", sql`${table.kind} = 'task'`),
    check("task_title_length", sql`char_length(${table.title}) <= 500`),
    check("task_bring_count", sql`cardinality(${table.bring}) <= 50`),
    check("task_bring_length", sql`texts_within(${table.bring}, 500)`),
    oneOf("task_status_known", table.status, taskStatuses),
    check("task_done_at_when_done", sql`(${table.status} = 'done') = (${table.doneAt} IS NOT NULL)`),
    index("task_status_deadline_idx").on(table.status, table.deadline),
  ],
);

/** One slot of a Timetable; `change` is its Timetable Change, with the values it replaces. */
export const lessons = pgTable(
  "lesson",
  {
    ...detailOf("lesson"),
    subject: text("subject").notNull(),
    startsAt: timestamptz("starts_at").notNull(),
    endsAt: timestamptz("ends_at").notNull(),
    room: text("room"),
    teacher: text("teacher"),
    change: text("change"),
    previousSubject: text("previous_subject"),
    previousRoom: text("previous_room"),
    previousTeacher: text("previous_teacher"),
    note: text("note"),
  },
  (table) => [
    detailKey("lesson", table),
    check("lesson_kind", sql`${table.kind} = 'lesson'`),
    check("lesson_time_ordered", sql`${table.endsAt} >= ${table.startsAt}`),
    oneOf("lesson_change_known", table.change, timetableChangeKinds),
    check(
      "lesson_previous_only_when_changed",
      sql`${table.change} IS NOT NULL OR (${table.previousSubject} IS NULL AND ${table.previousRoom} IS NULL AND ${table.previousTeacher} IS NULL AND ${table.note} IS NULL)`,
    ),
    check(
      "lesson_text_length",
      sql`char_length(${table.subject}) <= 200 AND char_length(${table.room}) <= 200 AND char_length(${table.teacher}) <= 200 AND char_length(${table.previousSubject}) <= 200 AND char_length(${table.previousRoom}) <= 200 AND char_length(${table.previousTeacher}) <= 200 AND char_length(${table.note}) <= 200`,
    ),
    index("lesson_starts_at_idx").on(table.startsAt, table.endsAt),
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
