CREATE TABLE `source_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`captured_at` text,
	`hash` text NOT NULL,
	`supersedes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sources_project` ON `source_documents` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `ai_change_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ai_proposals_project` ON `ai_change_proposals` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `ai_proposal_changes` (
	`proposal_id` text NOT NULL,
	`change_id` text NOT NULL,
	`kind` text NOT NULL,
	`task_id` integer,
	`new_key` text,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`evidence_start` integer,
	`evidence_end` integer,
	`evidence_quote` text DEFAULT '' NOT NULL,
	`basis` text NOT NULL,
	`needs_review` text DEFAULT '' NOT NULL,
	`requires` text NOT NULL,
	`blocked` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`proposal_id`, `change_id`)
);
--> statement-breakpoint
CREATE TABLE `ai_change_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`proposal_id` text,
	`source_id` text,
	`reverts` text,
	`approved_by` text NOT NULL,
	`approved_at` text NOT NULL,
	`revision` integer NOT NULL,
	`entries` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ai_applications_project` ON `ai_change_applications` (`project_id`,`approved_at`);
