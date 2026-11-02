ALTER TABLE "project_policy" ALTER COLUMN "min_members" SET DEFAULT 1;
--> statement-breakpoint
UPDATE "project_policy" SET "min_members" = 1;
--> statement-breakpoint
UPDATE "project_policy" AS p SET "listed" = h."listed" FROM "hub_projects" AS h WHERE p."project_id" = h."project_id";
