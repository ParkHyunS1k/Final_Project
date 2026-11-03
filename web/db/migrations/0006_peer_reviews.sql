CREATE TABLE "peer_review_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "peer_review_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "peer_reviews" (
	"project_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"reviewee_id" text NOT NULL,
	"contribution" integer NOT NULL,
	"communication" integer NOT NULL,
	"commitment" integer NOT NULL,
	"submission_id" text NOT NULL,
	CONSTRAINT "peer_reviews_project_id_reviewer_id_reviewee_id_pk" PRIMARY KEY("project_id","reviewer_id","reviewee_id")
);
--> statement-breakpoint
ALTER TABLE "peer_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "peer_review_submissions" ADD CONSTRAINT "peer_review_submissions_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_reviews" ADD CONSTRAINT "peer_reviews_project_id_sprints_owner_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("owner") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_peer_submission_once" ON "peer_review_submissions" USING btree ("project_id","reviewer_id");--> statement-breakpoint
CREATE INDEX "idx_peer_reviews_reviewee" ON "peer_reviews" USING btree ("project_id","reviewee_id");