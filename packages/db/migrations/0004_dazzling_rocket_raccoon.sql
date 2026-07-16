ALTER TABLE "connections" ADD COLUMN "last_analytics_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "external_post_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "last_analytics_at" timestamp with time zone;