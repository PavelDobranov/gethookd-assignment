CREATE TABLE "billing_bindings" (
	"api_key_id" uuid NOT NULL,
	"value_hash" text NOT NULL,
	"fingerprint_hash" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "billing_bindings_api_key_id_value_hash_pk" PRIMARY KEY("api_key_id","value_hash")
);
--> statement-breakpoint
CREATE TABLE "monthly_usage" (
	"owner_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "monthly_usage_owner_id_period_start_pk" PRIMARY KEY("owner_id","period_start"),
	CONSTRAINT "monthly_usage_count_check" CHECK ("monthly_usage"."count" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rate_admissions" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_bindings" ADD CONSTRAINT "billing_bindings_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_usage" ADD CONSTRAINT "monthly_usage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_bindings_key_expiry_idx" ON "billing_bindings" USING btree ("api_key_id","expires_at");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rate_admissions_check" CHECK (cardinality("api_keys"."rate_admissions") <= 60);