ALTER TABLE "llm_endpoints" ADD COLUMN "vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "conversion_problem" text;