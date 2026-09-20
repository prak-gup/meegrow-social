ALTER TABLE "post_groups" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "post_groups_workspace_idempotency_key_uniq" ON "post_groups" USING btree ("workspace_id","idempotency_key") WHERE "post_groups"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "idempotency_key";