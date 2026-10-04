CREATE TABLE "invite_quota" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "invite_quota_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "invite_quota" ENABLE ROW LEVEL SECURITY;