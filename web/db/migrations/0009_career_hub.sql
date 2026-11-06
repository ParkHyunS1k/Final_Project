CREATE TABLE "career_ai_quota" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "career_ai_quota_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "career_ai_quota" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_experiences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" integer NOT NULL,
	"task_version" integer NOT NULL,
	"task_title" text NOT NULL,
	"skill_ids" jsonb NOT NULL,
	"evidence" text NOT NULL,
	"contribution" text NOT NULL,
	"resume_bullet" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_experiences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_profile_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"input" jsonb NOT NULL,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_profile_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_profile_writes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"claim_id" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "career_profile_writes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"snapshot_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_project_links" (
	"project_id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"goal_version" integer NOT NULL,
	"created_by" text NOT NULL,
	"profile_id" text,
	"request_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_project_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_project_profiles" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"skills" jsonb NOT NULL,
	"learning_goals" jsonb NOT NULL,
	"preferred_roles" jsonb NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_project_profiles_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "career_project_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_role_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"goal_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_role_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "career_task_links" (
	"project_id" text NOT NULL,
	"task_id" integer NOT NULL,
	"template_key" text NOT NULL,
	"work_role" text NOT NULL,
	"skill_ids" jsonb NOT NULL,
	CONSTRAINT "career_task_links_project_id_task_id_pk" PRIMARY KEY("project_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "career_task_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_interests" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"invitation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_interests_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hub_interests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"template" jsonb NOT NULL,
	"scope_level" integer NOT NULL,
	"mode" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_records" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_records_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "hub_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_policy" ADD COLUMN "completion_mode" text DEFAULT 'deliverables' NOT NULL;--> statement-breakpoint
ALTER TABLE "career_experiences" ADD CONSTRAINT "career_experiences_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_profile_versions" ADD CONSTRAINT "career_profile_versions_user_id_career_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."career_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_project_links" ADD CONSTRAINT "career_project_links_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_project_links" ADD CONSTRAINT "career_project_links_profile_id_career_profile_versions_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."career_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_project_profiles" ADD CONSTRAINT "career_project_profiles_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_project_profiles" ADD CONSTRAINT "career_project_profiles_profile_id_career_profile_versions_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."career_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_role_proposals" ADD CONSTRAINT "career_role_proposals_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_task_links" ADD CONSTRAINT "career_task_links_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_interests" ADD CONSTRAINT "hub_interests_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_projects" ADD CONSTRAINT "hub_projects_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_career_experience_task" ON "career_experiences" USING btree ("user_id","project_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_career_profile_version" ON "career_profile_versions" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_career_project_request" ON "career_project_links" USING btree ("created_by","request_id");--> statement-breakpoint
CREATE INDEX "idx_career_proposal_project" ON "career_role_proposals" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_career_template_task" ON "career_task_links" USING btree ("project_id","template_key");