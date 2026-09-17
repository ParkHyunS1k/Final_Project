ALTER TABLE `sprint_tasks` ADD `due_at` text;
--> statement-breakpoint
ALTER TABLE `sprint_tasks` ADD `deadline_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `reminder_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`task_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`deadline_version` integer NOT NULL,
	`stage_minutes` integer NOT NULL,
	`due_at` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`batch_id` text,
	`claim_owner` text,
	`claimed_at` text,
	`resolved_at` text,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reminder_logical` ON `reminder_items` (`project_id`,`kind`,`task_id`,`user_id`,`deadline_version`,`stage_minutes`);
--> statement-breakpoint
CREATE INDEX `idx_reminder_due` ON `reminder_items` (`status`,`scheduled_at`);
--> statement-breakpoint
CREATE TABLE `reminder_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`email` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`provider_message_id` text,
	`error` text DEFAULT '' NOT NULL,
	`first_attempt_at` text NOT NULL,
	`last_attempt_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_batch_slot` ON `reminder_batches` (`project_id`,`user_id`,`scheduled_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_batch_idempotency` ON `reminder_batches` (`idempotency_key`);
