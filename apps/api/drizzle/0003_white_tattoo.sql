-- Only the public fixture's prefix is known. Do not invent metadata for other
-- pre-M4 hashes or expose their hashes in diagnostics. Check before any DDL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "api_keys"
    WHERE "key_hash" <> '58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47'
  ) THEN
    RAISE EXCEPTION 'Cannot backfill API key prefixes: unsupported legacy keys require human resolution.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "prefix" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" text[];--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
-- created_at is migration time, not a recovered historical issuance time.
UPDATE "api_keys"
SET "prefix" = 'gethookd-publ', "scopes" = ARRAY['search:read', 'keys:manage']::text[]
WHERE "key_hash" = '58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47';