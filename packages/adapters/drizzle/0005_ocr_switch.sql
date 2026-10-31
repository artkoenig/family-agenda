ALTER TABLE "settings" ADD COLUMN "ocr_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_endpoints" DROP COLUMN "vision";