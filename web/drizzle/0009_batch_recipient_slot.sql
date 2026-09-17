DROP INDEX `idx_batch_slot`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_batch_slot` ON `reminder_batches` (`user_id`,`scheduled_at`);
