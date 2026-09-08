CREATE TABLE `project_details` (
	`project_id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`goal` text NOT NULL,
	`deliverables` text NOT NULL,
	`completion_criteria` text NOT NULL,
	`legacy` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`accepted_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_invites_token_hash_unique` ON `project_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invites_project` ON `project_invites` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`person` integer NOT NULL,
	`agreed_at` text,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_members_user` ON `project_members` (`user_id`);