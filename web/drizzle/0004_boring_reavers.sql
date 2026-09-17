ALTER TABLE `sprint_tasks` ADD `status` text DEFAULT 'todo' NOT NULL;--> statement-breakpoint
ALTER TABLE `sprint_tasks` ADD `description` text DEFAULT '' NOT NULL;