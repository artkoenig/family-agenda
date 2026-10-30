ALTER TABLE "views" ADD COLUMN "kind" text DEFAULT 'timeline' NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_kind_known" CHECK ("views"."kind" IN ('timeline', 'tasks'));