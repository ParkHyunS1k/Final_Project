ALTER TABLE "hub_interests" ADD COLUMN "email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_interests" ADD COLUMN "invitation" jsonb;