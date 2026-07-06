CREATE TABLE `replay_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`eval_task_id` text NOT NULL,
	`variant` text NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`turns` integer,
	`total_input_tokens` integer,
	`total_output_tokens` integer,
	`total_cache_read` integer,
	`diff_path` text,
	`diff_stat` text,
	`final_message_path` text,
	`verify_passed` integer,
	`error_message` text,
	FOREIGN KEY (`eval_task_id`) REFERENCES `eval_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_replay_runs_task` ON `replay_runs` (`eval_task_id`,`variant`);
--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` text PRIMARY KEY NOT NULL,
	`eval_task_id` text NOT NULL,
	`candidate_run_id` text NOT NULL,
	`baseline_run_id` text NOT NULL,
	`position` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`verdict` text NOT NULL,
	`scores_json` text,
	`rationale` text,
	FOREIGN KEY (`eval_task_id`) REFERENCES `eval_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`baseline_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_judgments_task` ON `judgments` (`eval_task_id`,`candidate_run_id`,`position`);
--> statement-breakpoint
CREATE TABLE `human_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`eval_task_id` text NOT NULL,
	`candidate_run_id` text NOT NULL,
	`baseline_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`source` text DEFAULT 'review_session' NOT NULL,
	`verdict` text NOT NULL,
	`note` text,
	`review_seconds` integer,
	FOREIGN KEY (`eval_task_id`) REFERENCES `eval_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`baseline_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_human_reviews_task` ON `human_reviews` (`eval_task_id`);
