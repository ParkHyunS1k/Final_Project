CREATE TABLE "project_repo_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_repo_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_repos" (
	"project_id" text PRIMARY KEY NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"version" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_repos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_issue_spans" (
	"source_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"author_login" text NOT NULL,
	"author_is_member" boolean NOT NULL,
	CONSTRAINT "source_issue_spans_source_id_issue_number_pk" PRIMARY KEY("source_id","issue_number")
);
--> statement-breakpoint
ALTER TABLE "source_issue_spans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_project_repo_events" ON "project_repo_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_source_issue_spans_repo" ON "source_issue_spans" USING btree ("project_id","repo","issue_number");