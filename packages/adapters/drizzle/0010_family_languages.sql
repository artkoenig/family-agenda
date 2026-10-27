ALTER TABLE "families" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN "ocr_languages" text[] DEFAULT '{eng}'::text[] NOT NULL;