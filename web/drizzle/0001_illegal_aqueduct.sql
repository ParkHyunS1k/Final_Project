CREATE INDEX `idx_checkins_owner_createdAt` ON `sprint_checkins` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_events_owner_revision` ON `sprint_events` (`owner`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_proposals_owner_createdAt` ON `sprint_proposals` (`owner`,`created_at`);