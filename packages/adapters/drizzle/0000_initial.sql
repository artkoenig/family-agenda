CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "background_activities" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"kind" text NOT NULL,
	"done" integer NOT NULL,
	"total" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "background_activities_single_row" CHECK ("background_activities"."id"),
	CONSTRAINT "background_activities_kind_known" CHECK ("background_activities"."kind" IN ('polling', 'extracting')),
	CONSTRAINT "background_activities_progress" CHECK (0 <= "background_activities"."done" AND "background_activities"."done" <= "background_activities"."total")
);
--> statement-breakpoint
CREATE TABLE "catalogue_entries" (
	"source_type_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"first_seen_in" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"poll_interval_seconds" integer,
	CONSTRAINT "catalogue_entries_source_type_id_entry_id_pk" PRIMARY KEY("source_type_id","entry_id"),
	CONSTRAINT "catalogue_entries_poll_interval_positive" CHECK ("catalogue_entries"."poll_interval_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "family_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "family_members_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"photo_blob" text,
	"photo_content_type" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "family_members_photo_complete" CHECK ((("family_members"."photo_blob" IS NULL) = ("family_members"."photo_content_type" IS NULL))),
	CONSTRAINT "family_members_photo_content_type_known" CHECK ("family_members"."photo_content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif'))
);
--> statement-breakpoint
CREATE TABLE "item_keys" (
	"source_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"item_id" uuid NOT NULL,
	CONSTRAINT "item_keys_source_id_item_key_pk" PRIMARY KEY("source_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"folded" jsonb,
	"window" "tstzrange",
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "items_kind_known" CHECK ("items"."kind" IN ('event', 'lesson', 'timetable-change', 'task', 'notice'))
);
--> statement-breakpoint
CREATE TABLE "llm_endpoints" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_ref" text,
	"vision" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_endpoints_single_row" CHECK ("llm_endpoints"."id")
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"raw_message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"blob" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"conversion_problem" text,
	CONSTRAINT "message_attachments_raw_message_id_position_pk" PRIMARY KEY("raw_message_id","position"),
	CONSTRAINT "message_attachments_position_not_negative" CHECK ("message_attachments"."position" >= 0),
	CONSTRAINT "message_attachments_size_not_negative" CHECK ("message_attachments"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "origins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"link" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "origins_source_external_id_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "raw_messages" (
	"origin_id" uuid PRIMARY KEY NOT NULL,
	"thread" text,
	"sent_at" timestamp with time zone NOT NULL,
	"text_blob" text NOT NULL,
	"text_sha256" text NOT NULL,
	"text_size" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"extracted_at" timestamp with time zone,
	CONSTRAINT "raw_messages_text_size_not_negative" CHECK ("raw_messages"."text_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"item_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"act" text NOT NULL,
	"fields" jsonb NOT NULL,
	"source_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"accepted" boolean NOT NULL,
	"rejection" text,
	"evidence" text,
	"fingerprint" text NOT NULL,
	CONSTRAINT "revisions_origin_fingerprint_unique" UNIQUE("origin_id","fingerprint"),
	CONSTRAINT "revisions_act_known" CHECK ("revisions"."act" IN ('create', 'change', 'move', 'cancel')),
	CONSTRAINT "revisions_rejection_only_when_rejected" CHECK ("revisions"."rejection" IS NULL OR NOT "revisions"."accepted")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"recovery_kit_confirmed_at" timestamp with time zone,
	"language" text DEFAULT 'en' NOT NULL,
	"ocr_languages" text[] DEFAULT '{eng}'::text[] NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id"),
	CONSTRAINT "settings_language_known" CHECK ("settings"."language" IN ('en', 'de')),
	CONSTRAINT "settings_ocr_languages_not_empty" CHECK (cardinality("settings"."ocr_languages") > 0)
);
--> statement-breakpoint
CREATE TABLE "sign_in_failures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sign_in_failures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_health" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"last_error_kind" text,
	"last_error" text,
	"last_new_origin_at" timestamp with time zone,
	CONSTRAINT "source_health_failure_complete" CHECK ((("source_health"."failing_since" IS NULL) = ("source_health"."last_error_kind" IS NULL)) AND (("source_health"."failing_since" IS NULL) = ("source_health"."last_error" IS NULL))),
	CONSTRAINT "source_health_last_error_kind_known" CHECK ("source_health"."last_error_kind" IN ('definite', 'temporary'))
);
--> statement-breakpoint
CREATE TABLE "source_members" (
	"source_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "source_members_source_id_family_member_id_pk" PRIMARY KEY("source_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "source_types" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"first_seen_in" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"is_new" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "sources_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_type_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"secret_refs" jsonb NOT NULL,
	"state" text,
	"poll_interval_seconds" integer,
	"shown" boolean DEFAULT true NOT NULL,
	"name" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sources_poll_interval_positive" CHECK ("sources"."poll_interval_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "view_preselections" (
	"view_id" uuid NOT NULL,
	"family_member_id" uuid NOT NULL,
	CONSTRAINT "view_preselections_view_id_family_member_id_pk" PRIMARY KEY("view_id","family_member_id")
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "views_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"horizon_days" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "views_horizon_days_in_range" CHECK ("views"."horizon_days" BETWEEN 1 AND 31)
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_entries" ADD CONSTRAINT "catalogue_entries_source_type_id_source_types_id_fk" FOREIGN KEY ("source_type_id") REFERENCES "public"."source_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_keys" ADD CONSTRAINT "item_keys_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_keys" ADD CONSTRAINT "item_keys_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_raw_message_id_raw_messages_origin_id_fk" FOREIGN KEY ("raw_message_id") REFERENCES "public"."raw_messages"("origin_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origins" ADD CONSTRAINT "origins_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_messages" ADD CONSTRAINT "raw_messages_origin_id_origins_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_origin_id_origins_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_health" ADD CONSTRAINT "source_health_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_members" ADD CONSTRAINT "source_members_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_members" ADD CONSTRAINT "source_members_family_member_id_family_members_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_source_type_id_source_types_id_fk" FOREIGN KEY ("source_type_id") REFERENCES "public"."source_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_preselections" ADD CONSTRAINT "view_preselections_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_preselections" ADD CONSTRAINT "view_preselections_family_member_id_family_members_id_fk" FOREIGN KEY ("family_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "item_keys_item_id_idx" ON "item_keys" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "items_window_idx" ON "items" USING gist ("window");--> statement-breakpoint
CREATE INDEX "raw_messages_pending_idx" ON "raw_messages" USING btree ("received_at") WHERE "raw_messages"."extracted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "raw_messages_thread_idx" ON "raw_messages" USING btree ("thread");--> statement-breakpoint
CREATE INDEX "revisions_item_id_idx" ON "revisions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "sign_in_failures_key_at_idx" ON "sign_in_failures" USING btree ("key","at");--> statement-breakpoint
CREATE INDEX "source_members_family_member_id_idx" ON "source_members" USING btree ("family_member_id");--> statement-breakpoint
CREATE INDEX "sources_source_type_id_idx" ON "sources" USING btree ("source_type_id");--> statement-breakpoint
CREATE INDEX "view_preselections_family_member_id_idx" ON "view_preselections" USING btree ("family_member_id");--> statement-breakpoint
-- The one row of the Instance's Family settings (ADR-0013).
INSERT INTO "settings" DEFAULT VALUES;
