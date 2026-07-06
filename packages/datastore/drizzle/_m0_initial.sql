CREATE TABLE `quota_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_quota_window` ON `quota_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`replay_run_id` text,
	`created_at` integer NOT NULL,
	`model_requested` text NOT NULL,
	`model_served` text NOT NULL,
	`is_streaming` integer NOT NULL,
	`message_count` integer NOT NULL,
	`tool_count` integer NOT NULL,
	`has_tool_results` integer NOT NULL,
	`has_images` integer NOT NULL,
	`system_hash` text,
	`prompt_hash` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`status` text NOT NULL,
	`http_status` integer,
	`stop_reason` text,
	`latency_ms` integer,
	`ttft_ms` integer,
	`error_message` text,
	`body_path` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_requests_created` ON `requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_requests_session` ON `requests` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_requests_replay` ON `requests` (`replay_run_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`cwd` text,
	`git_remote` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shift_events` (
	`request_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`policy_version` text NOT NULL,
	`task_event_id` text,
	`decided_category` text,
	`gear_from` text NOT NULL,
	`gear_to` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_event_id`) REFERENCES `task_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`cwd` text NOT NULL,
	`git_head` text,
	`git_dirty` integer NOT NULL,
	`prompt_text` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`task_category` text,
	`category_source` text,
	`category_confidence` real,
	`self_contained` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_events_created` ON `task_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_task_events_category` ON `task_events` (`task_category`,`created_at`);