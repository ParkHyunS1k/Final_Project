ALTER TABLE "project_invites" ADD COLUMN "email_status" text;--> statement-breakpoint
ALTER TABLE "project_invites" ADD COLUMN "email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_invites" ADD COLUMN "email_sends" integer DEFAULT 0 NOT NULL;