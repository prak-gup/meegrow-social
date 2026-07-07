CREATE TABLE "oauth_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text,
	"redirect_uri" text NOT NULL,
	"encrypted_tokens" text,
	"accounts" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
