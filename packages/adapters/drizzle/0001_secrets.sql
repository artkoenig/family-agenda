CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
