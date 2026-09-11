CREATE TABLE `sprint_capacity` (
	`owner` text NOT NULL,
	`person` integer NOT NULL,
	`date` text NOT NULL,
	`hours` real NOT NULL,
	PRIMARY KEY(`owner`, `person`, `date`),
	FOREIGN KEY (`owner`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sprint_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`task_id` integer NOT NULL,
	`note` text NOT NULL,
	`remaining` real NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sprint_dependencies` (
	`owner` text NOT NULL,
	`task_id` integer NOT NULL,
	`depends_on` integer NOT NULL,
	PRIMARY KEY(`owner`, `task_id`, `depends_on`),
	FOREIGN KEY (`owner`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sprint_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sprint_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`base_revision` integer NOT NULL,
	`defer_ids` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sprints` (
	`owner` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`start_date` text NOT NULL,
	`deadline` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`mutation` text DEFAULT '' NOT NULL,
	`joined` integer DEFAULT 0 NOT NULL,
	`finished` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sprint_tasks` (
	`owner` text NOT NULL,
	`id` integer NOT NULL,
	`title` text NOT NULL,
	`person` integer NOT NULL,
	`remaining` real NOT NULL,
	`optional` integer DEFAULT 0 NOT NULL,
	`deferred` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`owner`, `id`),
	FOREIGN KEY (`owner`) REFERENCES `sprints`(`owner`) ON UPDATE no action ON DELETE no action
);
