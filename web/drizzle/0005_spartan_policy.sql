CREATE TABLE `project_policy` (
	`project_id` text PRIMARY KEY NOT NULL,
	`lifecycle` text DEFAULT 'draft' NOT NULL,
	`goal_version` integer DEFAULT 1 NOT NULL,
	`duration_days` integer NOT NULL,
	`daily_hours` real DEFAULT 8 NOT NULL,
	`started_at` text,
	`deadline_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_agreement` (
	`project_id` text PRIMARY KEY NOT NULL,
	`goal_version` integer NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`scope` text NOT NULL,
	`completion_criteria` text NOT NULL,
	`fixed_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_deliverables` (
	`project_id` text NOT NULL,
	`deliverable_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`fixed_at` text,
	`evidence` text DEFAULT '' NOT NULL,
	`evidence_by` text,
	`evidence_at` text,
	`confirmed` integer DEFAULT 0 NOT NULL,
	`confirmed_by` text,
	`confirmed_at` text,
	PRIMARY KEY(`project_id`, `deliverable_id`),
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_deliverables_project_position` ON `project_deliverables` (`project_id`,`position`);
--> statement-breakpoint
ALTER TABLE `project_members` ADD `agreed_goal_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `project_members` ADD `email` text;
--> statement-breakpoint
ALTER TABLE `project_members` ADD `left_at` text;
--> statement-breakpoint
ALTER TABLE `project_members` ADD `left_note` text DEFAULT '' NOT NULL;
