CREATE TABLE `feedback_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	`text` text NOT NULL,
	`parsed_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolution` text
);
