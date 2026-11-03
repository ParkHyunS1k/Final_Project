CREATE TABLE "career_profile_writes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"claim_id" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "career_profile_writes" ENABLE ROW LEVEL SECURITY;