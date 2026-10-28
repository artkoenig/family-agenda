import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  integer,
  jsonb,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const families = pgTable("families", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  recoveryKitConfirmedAt: timestamp("recovery_kit_confirmed_at", { withTimezone: true }),
  /** The Family Language, `en` or `de`, which dates are formatted in. */
  language: text("language").notNull().default("en"),
  /** The Tesseract codes OCR reads in, in order; by default the one of the Family Language. */
  ocrLanguages: text("ocr_languages").array().notNull().default(sql`'{eng}'::text[]`),
});

export const admins = pgTable("admins", {
  id: uuid("id").primaryKey(),
  familyId: uuid("family_id")
    .notNull()
    .references(() => families.id),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const adminSessions = pgTable("admin_sessions", {
  id: text("id").primaryKey(),
  adminId: uuid("admin_id")
    .notNull()
    .references(() => admins.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const signInFailures = pgTable(
  "sign_in_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: text("key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (table) => [index("sign_in_failures_key_at_idx").on(table.key, table.at)],
);

/** Envelope-encrypted secrets (ADR-0006); the master key that unwraps them is not in Postgres. */
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey(),
  wrappedDataKey: bytea("wrapped_data_key").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const familyMembers = pgTable("family_members", {
  id: uuid("id").primaryKey(),
  /** The order Family Members were added in, which lists and quick filters keep. */
  position: bigserial("position", { mode: "number" }).notNull(),
  familyId: uuid("family_id")
    .notNull()
    .references(() => families.id),
  name: text("name").notNull(),
  /** The photo in the BlobStore, if any, and its image format. */
  photoBlob: text("photo_blob"),
  photoContentType: text("photo_content_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const views = pgTable("views", {
  id: uuid("id").primaryKey(),
  position: bigserial("position", { mode: "number" }).notNull(),
  familyId: uuid("family_id")
    .notNull()
    .references(() => families.id),
  horizonDays: integer("horizon_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

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
  (table) => [primaryKey({ columns: [table.viewId, table.familyMemberId] })],
);

/** Per Source Type id, whether an Admin enabled it and when it was discovered (ADR-0010). */
export const sourceTypes = pgTable("source_types", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** The application version the Source Type was first discovered in. */
  firstSeenIn: text("first_seen_in").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  /** Until an Admin opens the list of Source Types. */
  isNew: boolean("is_new").notNull().default(true),
});

/**
 * Sources of every Source Type, so that a new one needs no migration. A Source keeps its
 * Source Type id even when the plugin is removed, and resumes once it is installed again.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    position: bigserial("position", { mode: "number" }).notNull(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    sourceTypeId: text("source_type_id").notNull(),
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
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** When it last ran successfully, which the Admin area shows. */
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    /** The first failed run since the last successful one; null while it runs successfully. */
    failingSince: timestamp("failing_since", { withTimezone: true }),
    /** `definite` once any error since `failingSince` was, else `temporary`; null with `failingSince`. */
    lastErrorKind: text("last_error_kind"),
    /** The message of the last error; null with `failingSince`. */
    lastError: text("last_error"),
    /** When its last Origin not seen before was recorded, for the Silent status. */
    lastNewOriginAt: timestamp("last_new_origin_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("sources_source_type_id_idx").on(table.sourceTypeId)],
);

/**
 * Attribution Rules: the Items of a Source's Origins whose attribute has the value concern the
 * rule's Family Members, or the whole Family. Removing the Source removes its rules.
 */
export const attributionRules = pgTable(
  "attribution_rules",
  {
    id: uuid("id").primaryKey(),
    position: bigserial("position", { mode: "number" }).notNull(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** The key of the Origin attribute, as the Source's plugin declares it. */
    attribute: text("attribute").notNull(),
    value: text("value").notNull(),
    /** Whether it concerns the whole Family; otherwise its Family Members. */
    wholeFamily: boolean("whole_family").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [unique("attribution_rules_source_attribute_value_unique").on(table.sourceId, table.attribute, table.value)],
);

/** The Family Members a rule assigns; removing a Family Member removes them here too. */
export const attributionRuleMembers = pgTable(
  "attribution_rule_members",
  {
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => attributionRules.id, { onDelete: "cascade" }),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.ruleId, table.familyMemberId] })],
);

/**
 * Appearances of Items in Sources (ADR-0009). Removing a Source removes them, with their raw
 * messages, Revisions and Items, in the same transaction as the Source itself.
 */
export const origins = pgTable(
  "origins",
  {
    id: uuid("id").primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    sourceId: uuid("source_id").notNull(),
    /** The Origin's id within its Source, such as a calendar entry's UID. */
    externalId: text("external_id").notNull(),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull(),
    link: text("link"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [unique("origins_source_external_id_unique").on(table.sourceId, table.externalId)],
);

/**
 * Items as projections of their Revisions: `folded` and the window are recomputed whenever one of
 * their Revisions arrives, and never written otherwise.
 */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    kind: text("kind").notNull(),
    folded: jsonb("folded").$type<{ fields: Record<string, unknown>; cancelled: boolean }>(),
    /** Instants certainly before and after the Item's time, to find it by. */
    windowFrom: timestamp("window_from", { withTimezone: true }),
    windowTo: timestamp("window_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("items_family_window_idx").on(table.familyId, table.windowFrom, table.windowTo)],
);

/** Which Item a Source's own key for it, such as a calendar UID, belongs to. */
export const itemKeys = pgTable(
  "item_keys",
  {
    sourceId: uuid("source_id").notNull(),
    itemKey: text("item_key").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.itemKey] })],
);

/** Append-only statements about Items (ADR-0009). */
export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey(),
    /** The order Revisions were received in, which decides between equal source times. */
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    originId: uuid("origin_id")
      .notNull()
      .references(() => origins.id),
    act: text("act").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
    sourceTime: timestamp("source_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
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
  ],
);

/**
 * Messages to extract Items from, one per Origin. Their text and attachments are files in the
 * BlobStore; Postgres keeps only where they are and a hash of them (ADR-0006).
 */
export const rawMessages = pgTable(
  "raw_messages",
  {
    id: uuid("id").primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    originId: uuid("origin_id")
      .notNull()
      .unique()
      .references(() => origins.id),
    sourceId: uuid("source_id").notNull(),
    /** The conversation within the Source, such as a mail thread. */
    thread: text("thread"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    textBlob: text("text_blob").notNull(),
    textSha256: text("text_sha256").notNull(),
    textSize: integer("text_size").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** When it was extracted successfully, which happens once (ADR-0009); null while it waits. */
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
  },
  (table) => [
    index("raw_messages_pending_idx").on(table.receivedAt).where(sql`${table.extractedAt} IS NULL`),
    index("raw_messages_source_thread_idx").on(table.sourceId, table.thread),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey(),
    rawMessageId: uuid("raw_message_id")
      .notNull()
      .references(() => rawMessages.id),
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
  (table) => [index("message_attachments_raw_message_id_idx").on(table.rawMessageId)],
);

/** The Family's one LLM endpoint; its API key is in the SecretStore. */
export const llmEndpoints = pgTable("llm_endpoints", {
  familyId: uuid("family_id")
    .primaryKey()
    .references(() => families.id),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiKeyRef: text("api_key_ref"),
  /** Whether its model reads images, so that scanned pages are sent to it rather than to OCR. */
  vision: boolean("vision").notNull().default(false),
  /** When an Admin acknowledged that third parties' messages are sent to it; null for a local one. */
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
});

/** What the worker is busy with, one row per Family while it is; read by the api for the Views. */
export const backgroundActivities = pgTable("background_activities", {
  familyId: uuid("family_id")
    .primaryKey()
    .references(() => families.id),
  /** `polling` or `extracting`. */
  kind: text("kind").notNull(),
  done: integer("done").notNull(),
  total: integer("total").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
