-- The Sources being added in the background, so that every core of the Family can tell how far they got.
CREATE TABLE "source_adding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "source_adding_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_type_id" text NOT NULL,
	"progress" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "source_adding_source_type_idx" ON "source_adding" USING btree ("source_type_id","position");