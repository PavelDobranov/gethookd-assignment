CREATE TABLE "ads" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" integer NOT NULL,
	"headline" text NOT NULL,
	"body_text" text NOT NULL,
	"niche" text NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"impression_rank" integer,
	"countries" text[] NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ads_brand_rank_unique" UNIQUE("brand_id","impression_rank"),
	CONSTRAINT "ads_niche_check" CHECK ("ads"."niche" IN ('skincare', 'haircare', 'supplements', 'fitness', 'pet-supplies', 'home-decor', 'kitchen', 'apparel', 'jewelry', 'baby-kids', 'outdoor', 'tech-accessories')),
	CONSTRAINT "ads_format_check" CHECK ("ads"."format" IN ('image', 'video', 'carousel')),
	CONSTRAINT "ads_status_check" CHECK ("ads"."status" IN ('active', 'inactive')),
	CONSTRAINT "ads_impression_rank_check" CHECK ("ads"."impression_rank" > 0),
	CONSTRAINT "ads_status_end_date_check" CHECK (("ads"."status" = 'active' AND "ads"."end_date" IS NULL) OR ("ads"."status" = 'inactive' AND "ads"."end_date" IS NOT NULL)),
	CONSTRAINT "ads_date_order_check" CHECK ("ads"."end_date" >= "ads"."start_date")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;