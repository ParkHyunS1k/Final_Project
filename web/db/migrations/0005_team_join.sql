CREATE TABLE "project_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"goal_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "project_join_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_policy" ADD COLUMN "listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_join_requests_pending" ON "project_join_requests" USING btree ("project_id","user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_join_requests_user" ON "project_join_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_join_requests_project" ON "project_join_requests" USING btree ("project_id","status");