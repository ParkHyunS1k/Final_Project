CREATE TABLE "hub_interests" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_interests_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hub_interests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"template" jsonb NOT NULL,
	"scope_level" integer NOT NULL,
	"mode" text NOT NULL,
	"listed" boolean DEFAULT false NOT NULL
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
ALTER TABLE "career_project_links" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_policy" ADD COLUMN "min_members" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_policy" ADD COLUMN "completion_mode" text DEFAULT 'deliverables' NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_interests" ADD CONSTRAINT "hub_interests_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_projects" ADD CONSTRAINT "hub_projects_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;