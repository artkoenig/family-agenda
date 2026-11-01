-- Singular table names, run state apart from configuration, and no "new Source Types" marks
-- (ADR-0016). Renamed in place, so that the Instance keeps its Admins, Sources and settings.
ALTER TABLE "settings" RENAME TO "family";--> statement-breakpoint
ALTER TABLE "family" RENAME CONSTRAINT "settings_pkey" TO "family_pkey";--> statement-breakpoint
ALTER TABLE "family" RENAME CONSTRAINT "settings_single_row" TO "family_single_row";--> statement-breakpoint
ALTER TABLE "family" RENAME CONSTRAINT "settings_language_known" TO "family_language_known";--> statement-breakpoint
ALTER TABLE "family" RENAME CONSTRAINT "settings_ocr_languages_not_empty" TO "family_ocr_languages_not_empty";--> statement-breakpoint
ALTER TABLE "admins" RENAME TO "admin";--> statement-breakpoint
ALTER TABLE "admin" RENAME CONSTRAINT "admins_pkey" TO "admin_pkey";--> statement-breakpoint
ALTER TABLE "admin" RENAME CONSTRAINT "admins_email_unique" TO "admin_email_unique";--> statement-breakpoint
ALTER TABLE "admin" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "admin" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "admin_sessions" RENAME TO "admin_session";--> statement-breakpoint
ALTER TABLE "admin_session" RENAME CONSTRAINT "admin_sessions_pkey" TO "admin_session_pkey";--> statement-breakpoint
ALTER TABLE "admin_session" RENAME CONSTRAINT "admin_sessions_admin_id_admins_id_fk" TO "admin_session_admin_id_admin_id_fk";--> statement-breakpoint
ALTER INDEX "admin_sessions_admin_id_idx" RENAME TO "admin_session_admin_id_idx";--> statement-breakpoint
ALTER INDEX "admin_sessions_expires_at_idx" RENAME TO "admin_session_expires_at_idx";--> statement-breakpoint
ALTER TABLE "sign_in_failures" RENAME TO "sign_in_failure";--> statement-breakpoint
ALTER TABLE "sign_in_failure" RENAME CONSTRAINT "sign_in_failures_pkey" TO "sign_in_failure_pkey";--> statement-breakpoint
ALTER SEQUENCE "sign_in_failures_id_seq" RENAME TO "sign_in_failure_id_seq";--> statement-breakpoint
ALTER INDEX "sign_in_failures_key_at_idx" RENAME TO "sign_in_failure_key_at_idx";--> statement-breakpoint
ALTER TABLE "secrets" RENAME TO "secret";--> statement-breakpoint
ALTER TABLE "secret" RENAME CONSTRAINT "secrets_pkey" TO "secret_pkey";--> statement-breakpoint
ALTER TABLE "secret" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "family_members" RENAME TO "family_member";--> statement-breakpoint
ALTER TABLE "family_member" RENAME CONSTRAINT "family_members_pkey" TO "family_member_pkey";--> statement-breakpoint
ALTER TABLE "family_member" RENAME CONSTRAINT "family_members_photo_complete" TO "family_member_photo_complete";--> statement-breakpoint
ALTER TABLE "family_member" RENAME CONSTRAINT "family_members_photo_content_type_known" TO "family_member_photo_content_type_known";--> statement-breakpoint
ALTER SEQUENCE "family_members_position_seq" RENAME TO "family_member_position_seq";--> statement-breakpoint
ALTER TABLE "family_member" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "family_member" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "views" RENAME TO "agenda";--> statement-breakpoint
ALTER TABLE "agenda" RENAME CONSTRAINT "views_pkey" TO "agenda_pkey";--> statement-breakpoint
ALTER TABLE "agenda" RENAME CONSTRAINT "views_kind_known" TO "agenda_kind_known";--> statement-breakpoint
ALTER TABLE "agenda" RENAME CONSTRAINT "views_horizon_days_in_range" TO "agenda_horizon_days_in_range";--> statement-breakpoint
ALTER SEQUENCE "views_position_seq" RENAME TO "agenda_position_seq";--> statement-breakpoint
ALTER TABLE "agenda" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "agenda" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "view_preselections" RENAME TO "agenda_preselection";--> statement-breakpoint
ALTER TABLE "agenda_preselection" RENAME COLUMN "view_id" TO "agenda_id";--> statement-breakpoint
ALTER TABLE "agenda_preselection" RENAME CONSTRAINT "view_preselections_view_id_family_member_id_pk" TO "agenda_preselection_agenda_id_family_member_id_pk";--> statement-breakpoint
ALTER TABLE "agenda_preselection" RENAME CONSTRAINT "view_preselections_view_id_views_id_fk" TO "agenda_preselection_agenda_id_agenda_id_fk";--> statement-breakpoint
ALTER TABLE "agenda_preselection" RENAME CONSTRAINT "view_preselections_family_member_id_family_members_id_fk" TO "agenda_preselection_family_member_id_family_member_id_fk";--> statement-breakpoint
ALTER INDEX "view_preselections_family_member_id_idx" RENAME TO "agenda_preselection_family_member_id_idx";--> statement-breakpoint
ALTER TABLE "source_types" RENAME TO "source_type";--> statement-breakpoint
ALTER TABLE "source_type" RENAME CONSTRAINT "source_types_pkey" TO "source_type_pkey";--> statement-breakpoint
ALTER TABLE "source_type" DROP COLUMN "first_seen_in";--> statement-breakpoint
ALTER TABLE "source_type" DROP COLUMN "first_seen_at";--> statement-breakpoint
ALTER TABLE "source_type" DROP COLUMN "is_new";--> statement-breakpoint
ALTER TABLE "catalogue_entries" RENAME TO "catalogue_entry";--> statement-breakpoint
ALTER TABLE "catalogue_entry" RENAME CONSTRAINT "catalogue_entries_source_type_id_entry_id_pk" TO "catalogue_entry_source_type_id_entry_id_pk";--> statement-breakpoint
ALTER TABLE "catalogue_entry" RENAME CONSTRAINT "catalogue_entries_source_type_id_source_types_id_fk" TO "catalogue_entry_source_type_id_source_type_id_fk";--> statement-breakpoint
ALTER TABLE "catalogue_entry" RENAME CONSTRAINT "catalogue_entries_poll_interval_positive" TO "catalogue_entry_poll_interval_positive";--> statement-breakpoint
ALTER TABLE "catalogue_entry" DROP COLUMN "first_seen_in";--> statement-breakpoint
ALTER TABLE "catalogue_entry" DROP COLUMN "first_seen_at";--> statement-breakpoint
ALTER TABLE "sources" RENAME TO "source";--> statement-breakpoint
ALTER TABLE "source" RENAME CONSTRAINT "sources_pkey" TO "source_pkey";--> statement-breakpoint
ALTER TABLE "source" RENAME CONSTRAINT "sources_source_type_id_source_types_id_fk" TO "source_source_type_id_source_type_id_fk";--> statement-breakpoint
ALTER TABLE "source" RENAME CONSTRAINT "sources_poll_interval_positive" TO "source_poll_interval_positive";--> statement-breakpoint
ALTER SEQUENCE "sources_position_seq" RENAME TO "source_position_seq";--> statement-breakpoint
ALTER INDEX "sources_source_type_id_idx" RENAME TO "source_source_type_id_idx";--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "config" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "secret_refs" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "source_health" RENAME TO "source_run";--> statement-breakpoint
ALTER TABLE "source_run" RENAME CONSTRAINT "source_health_pkey" TO "source_run_pkey";--> statement-breakpoint
ALTER TABLE "source_run" RENAME CONSTRAINT "source_health_source_id_sources_id_fk" TO "source_run_source_id_source_id_fk";--> statement-breakpoint
ALTER TABLE "source_run" RENAME CONSTRAINT "source_health_failure_complete" TO "source_run_failure_complete";--> statement-breakpoint
ALTER TABLE "source_run" RENAME CONSTRAINT "source_health_last_error_kind_known" TO "source_run_last_error_kind_known";--> statement-breakpoint
ALTER TABLE "source_run" ADD COLUMN "sync_cursor" jsonb;--> statement-breakpoint
UPDATE "source_run" SET "sync_cursor" = to_jsonb("source"."state") FROM "source" WHERE "source"."id" = "source_run"."source_id" AND "source"."state" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "source" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "llm_endpoints" RENAME TO "llm_endpoint";--> statement-breakpoint
ALTER TABLE "llm_endpoint" RENAME CONSTRAINT "llm_endpoints_pkey" TO "llm_endpoint_pkey";--> statement-breakpoint
ALTER TABLE "llm_endpoint" RENAME CONSTRAINT "llm_endpoints_single_row" TO "llm_endpoint_single_row";--> statement-breakpoint
ALTER TABLE "background_activities" RENAME TO "background_activity";--> statement-breakpoint
ALTER TABLE "background_activity" RENAME CONSTRAINT "background_activities_pkey" TO "background_activity_pkey";--> statement-breakpoint
ALTER TABLE "background_activity" RENAME CONSTRAINT "background_activities_single_row" TO "background_activity_single_row";--> statement-breakpoint
ALTER TABLE "background_activity" RENAME CONSTRAINT "background_activities_kind_known" TO "background_activity_kind_known";--> statement-breakpoint
ALTER TABLE "background_activity" RENAME CONSTRAINT "background_activities_progress" TO "background_activity_progress";--> statement-breakpoint
ALTER TABLE "item_keys" RENAME CONSTRAINT "item_keys_source_id_sources_id_fk" TO "item_keys_source_id_source_id_fk";--> statement-breakpoint
ALTER TABLE "origins" RENAME CONSTRAINT "origins_source_id_sources_id_fk" TO "origins_source_id_source_id_fk";--> statement-breakpoint
ALTER TABLE "revisions" RENAME CONSTRAINT "revisions_view_id_views_id_fk" TO "revisions_view_id_agenda_id_fk";--> statement-breakpoint
ALTER TABLE "revisions" RENAME CONSTRAINT "revisions_admin_id_admins_id_fk" TO "revisions_admin_id_admin_id_fk";--> statement-breakpoint
ALTER TABLE "source_members" RENAME CONSTRAINT "source_members_source_id_sources_id_fk" TO "source_members_source_id_source_id_fk";--> statement-breakpoint
ALTER TABLE "source_members" RENAME CONSTRAINT "source_members_family_member_id_family_members_id_fk" TO "source_members_family_member_id_family_member_id_fk";
