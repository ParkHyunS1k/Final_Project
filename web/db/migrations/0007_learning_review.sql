CREATE TABLE "learning_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"status" text NOT NULL,
	"repo" text NOT NULL,
	"github_login" text NOT NULL,
	"commit_count" integer NOT NULL,
	"commits" jsonb NOT NULL,
	"digest" text NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb,
	"feedback" jsonb,
	"gaps" jsonb,
	"model" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "learning_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_links" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"github_login" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_links_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "review_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_quota" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "review_quota_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "review_quota" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learning_reviews" ADD CONSTRAINT "learning_reviews_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_learning_reviews_day" ON "learning_reviews" USING btree ("project_id","user_id","kind","day");--> statement-breakpoint
CREATE INDEX "idx_learning_reviews_user" ON "learning_reviews" USING btree ("project_id","user_id","created_at");