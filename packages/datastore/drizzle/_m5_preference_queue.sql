CREATE TABLE `preference_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`eval_task_id` text NOT NULL,
	`candidate_run_id` text NOT NULL,
	`baseline_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`priority` real NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` integer,
	`notified_at` integer,
	`answered_at` integer,
	`human_review_id` text,
	FOREIGN KEY (`eval_task_id`) REFERENCES `eval_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`baseline_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_review_id`) REFERENCES `human_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_preference_queue_pair` ON `preference_queue` (`eval_task_id`,`candidate_run_id`,`baseline_run_id`);--> statement-breakpoint
CREATE INDEX `idx_preference_queue_status` ON `preference_queue` (`status`,`created_at`);
