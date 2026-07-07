CREATE TABLE `feedback_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`feedback_note_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`proposal_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` integer,
	`decision_note` text,
	FOREIGN KEY (`feedback_note_id`) REFERENCES `feedback_notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feedback_proposals_note` ON `feedback_proposals` (`feedback_note_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_proposals_status` ON `feedback_proposals` (`status`,`created_at`);
