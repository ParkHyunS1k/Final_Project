CREATE TABLE "github_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"github_id" text NOT NULL,
	"login" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_accounts_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "github_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "github_link_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"github_id" text NOT NULL,
	"login" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_link_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_github_link_events_user" ON "github_link_events" USING btree ("user_id","created_at");