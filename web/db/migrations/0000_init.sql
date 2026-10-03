CREATE TABLE "ai_change_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text,
	"source_id" text,
	"reverts" text,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"revision" integer NOT NULL,
	"entries" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_change_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_change_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_change_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_proposal_changes" (
	"proposal_id" text NOT NULL,
	"change_id" text NOT NULL,
	"kind" text NOT NULL,
	"task_id" integer,
	"new_key" text,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"evidence_start" integer,
	"evidence_end" integer,
	"evidence_quote" text DEFAULT '' NOT NULL,
	"basis" text NOT NULL,
	"needs_review" text DEFAULT '' NOT NULL,
	"requires" text NOT NULL,
	"blocked" text DEFAULT '' NOT NULL,
	CONSTRAINT "ai_proposal_changes_proposal_id_change_id_pk" PRIMARY KEY("proposal_id","change_id")
);
--> statement-breakpoint
ALTER TABLE "ai_proposal_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sprint_capacity" (
	"owner" text NOT NULL,
	"person" integer NOT NULL,
	"date" date NOT NULL,
	"hours" double precision NOT NULL,
	CONSTRAINT "sprint_capacity_owner_person_date_pk" PRIMARY KEY("owner","person","date")
);
--> statement-breakpoint
ALTER TABLE "sprint_capacity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sprint_checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"task_id" integer NOT NULL,
	"note" text NOT NULL,
	"remaining" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprint_checkins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sprint_dependencies" (
	"owner" text NOT NULL,
	"task_id" integer NOT NULL,
	"depends_on" integer NOT NULL,
	CONSTRAINT "sprint_dependencies_owner_task_id_depends_on_pk" PRIMARY KEY("owner","task_id","depends_on")
);
--> statement-breakpoint
ALTER TABLE "sprint_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sprint_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprint_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_agreement" (
	"project_id" text PRIMARY KEY NOT NULL,
	"goal_version" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"scope" text NOT NULL,
	"completion_criteria" text NOT NULL,
	"fixed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_agreement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_deliverables" (
	"project_id" text NOT NULL,
	"deliverable_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"fixed_at" timestamp with time zone,
	"evidence" text DEFAULT '' NOT NULL,
	"evidence_by" text,
	"evidence_at" timestamp with time zone,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "project_deliverables_project_id_deliverable_id_pk" PRIMARY KEY("project_id","deliverable_id")
);
--> statement-breakpoint
ALTER TABLE "project_deliverables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_details" (
	"project_id" text PRIMARY KEY NOT NULL,
	"created_by" text NOT NULL,
	"goal" text NOT NULL,
	"deliverables" jsonb NOT NULL,
	"completion_criteria" text NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_details" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "project_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"person" integer NOT NULL,
	"agreed_at" timestamp with time zone,
	"joined_at" timestamp with time zone NOT NULL,
	"agreed_goal_version" integer DEFAULT 0 NOT NULL,
	"email" text,
	"left_at" timestamp with time zone,
	"left_note" text DEFAULT '' NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_policy" (
	"project_id" text PRIMARY KEY NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"goal_version" integer DEFAULT 1 NOT NULL,
	"duration_days" integer NOT NULL,
	"daily_hours" double precision DEFAULT 8 NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reminder_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"email" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"provider_message_id" text,
	"error" text DEFAULT '' NOT NULL,
	"first_attempt_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminder_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reminder_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"task_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"deadline_version" integer NOT NULL,
	"stage_minutes" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"batch_id" text,
	"claim_owner" text,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminder_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"captured_at" timestamp with time zone,
	"hash" text NOT NULL,
	"supersedes" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sprints" (
	"owner" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"start_date" date,
	"deadline" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"mutation" text DEFAULT '' NOT NULL,
	"joined" boolean DEFAULT false NOT NULL,
	"finished" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sprint_tasks" (
	"owner" text NOT NULL,
	"id" integer NOT NULL,
	"title" text NOT NULL,
	"person" integer NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"remaining" double precision NOT NULL,
	"due_at" timestamp with time zone,
	"deadline_version" integer DEFAULT 0 NOT NULL,
	"change_version" integer DEFAULT 0 NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"deferred" boolean DEFAULT false NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	CONSTRAINT "sprint_tasks_owner_id_pk" PRIMARY KEY("owner","id")
);
--> statement-breakpoint
ALTER TABLE "sprint_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_change_applications" ADD CONSTRAINT "ai_change_applications_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_change_proposals" ADD CONSTRAINT "ai_change_proposals_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_capacity" ADD CONSTRAINT "sprint_capacity_owner_sprints_owner_fk" FOREIGN KEY ("owner") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_checkins" ADD CONSTRAINT "sprint_checkins_owner_sprints_owner_fk" FOREIGN KEY ("owner") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_dependencies" ADD CONSTRAINT "sprint_dependencies_owner_sprints_owner_fk" FOREIGN KEY ("owner") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_events" ADD CONSTRAINT "sprint_events_owner_sprints_owner_fk" FOREIGN KEY ("owner") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agreement" ADD CONSTRAINT "project_agreement_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_deliverables" ADD CONSTRAINT "project_deliverables_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_details" ADD CONSTRAINT "project_details_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invites" ADD CONSTRAINT "project_invites_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policy" ADD CONSTRAINT "project_policy_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_batches" ADD CONSTRAINT "reminder_batches_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_items" ADD CONSTRAINT "reminder_items_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_tasks" ADD CONSTRAINT "sprint_tasks_owner_sprints_owner_fk" FOREIGN KEY ("owner") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_applications_project" ON "ai_change_applications" USING btree ("project_id","approved_at");--> statement-breakpoint
CREATE INDEX "idx_ai_proposals_project" ON "ai_change_proposals" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_checkins_owner_createdAt" ON "sprint_checkins" USING btree ("owner","created_at");--> statement-breakpoint
CREATE INDEX "idx_events_owner_revision" ON "sprint_events" USING btree ("owner","revision");--> statement-breakpoint
CREATE INDEX "idx_deliverables_project_position" ON "project_deliverables" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "idx_invites_project" ON "project_invites" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_members_project_person" ON "project_members" USING btree ("project_id","person");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_batch_slot" ON "reminder_batches" USING btree ("user_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_batch_idempotency" ON "reminder_batches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reminder_logical" ON "reminder_items" USING btree ("project_id","kind","task_id","user_id","deadline_version","stage_minutes");--> statement-breakpoint
CREATE INDEX "idx_reminder_due" ON "reminder_items" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_sources_project" ON "source_documents" USING btree ("project_id","created_at");