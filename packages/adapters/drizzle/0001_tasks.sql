ALTER TABLE "revisions" ALTER COLUMN "origin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "outstanding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "author" text DEFAULT 'origin' NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "view_id" uuid;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "admin_id" uuid;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_outstanding_idx" ON "items" USING btree ("id") WHERE "items"."outstanding";--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_author_known" CHECK ("revisions"."author" IN ('origin', 'view', 'admin'));--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_origin_only_of_origin" CHECK (("revisions"."author" = 'origin') = ("revisions"."origin_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_view_only_of_view" CHECK ("revisions"."view_id" IS NULL OR "revisions"."author" = 'view');--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_admin_only_of_admin" CHECK ("revisions"."admin_id" IS NULL OR "revisions"."author" = 'admin');