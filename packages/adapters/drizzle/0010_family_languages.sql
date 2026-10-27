ALTER TABLE "families" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN "ocr_languages" text[] DEFAULT '{eng}'::text[] NOT NULL;--> statement-breakpoint
-- Instances set up before there was a Family Language read scans in German, and keep doing so.
UPDATE "families" SET "ocr_languages" = '{deu}'::text[];
