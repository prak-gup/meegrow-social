ALTER TABLE "connections" ADD COLUMN "import_state" jsonb;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_import_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "source" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "platform_removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "metrics_post_metric_captured_idx" ON "metrics" USING btree ("post_id","metric","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_imported_external_uniq" ON "posts" USING btree ("connection_id","external_post_id") WHERE "posts"."source" = 'imported';--> statement-breakpoint
CREATE INDEX "posts_connection_external_idx" ON "posts" USING btree ("connection_id","external_post_id");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_imported_is_published" CHECK ("posts"."source" <> 'imported' or "posts"."status" = 'published');