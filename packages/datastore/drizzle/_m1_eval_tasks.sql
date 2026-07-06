CREATE TABLE `eval_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_event_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`task_category` text NOT NULL,
	`repo_path` text NOT NULL,
	`base_commit` text NOT NULL,
	`prompt_text` text NOT NULL,
	`verify_command` text,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`task_event_id`) REFERENCES `task_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_eval_tasks_batch` ON `eval_tasks` (`batch_id`,`status`);
