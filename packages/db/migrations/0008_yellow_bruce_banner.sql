ALTER TABLE "connect_invites" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD COLUMN "invite_id" uuid;