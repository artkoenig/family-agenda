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
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const families = pgTable("families", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  recoveryKitConfirmedAt: timestamp("recovery_kit_confirmed_at", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("sources_source_type_id_idx").on(table.sourceTypeId)],
);
