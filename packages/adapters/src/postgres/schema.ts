import {
  bigserial,
  customType,
  index,
  pgTable,
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
