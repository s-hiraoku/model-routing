CREATE TABLE `tier_profiles` (
	`batch_id` text NOT NULL,
	`variant` text NOT NULL,
	`task_category` text NOT NULL,
	`n` integer NOT NULL,
	`win_rate` real NOT NULL,
	`wilson_low` real NOT NULL,
	`wilson_high` real NOT NULL,
	`verify_pass_rate` real,
	`avg_turns` real,
	`avg_total_tokens` real,
	`avg_duration_ms` real,
	`error_rate` real NOT NULL,
	`judge_human_kappa` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tier_profiles_pk` ON `tier_profiles` (`batch_id`,`variant`,`task_category`);
