DROP INDEX IF EXISTS `idx_replay_runs_task`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_replay_runs_task` ON `replay_runs` (`eval_task_id`,`variant`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_judgments_task`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_judgments_task` ON `judgments` (`eval_task_id`,`candidate_run_id`,`position`);
