CREATE TABLE `client_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`m` integer NOT NULL,
	`i` integer NOT NULL,
	`decision` text NOT NULL,
	`actor` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_decisions_item_uq` ON `client_decisions` (`job_id`,`m`,`i`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`verifier_run_id` text NOT NULL,
	`item_id` text NOT NULL,
	`leaf_index` integer NOT NULL,
	`leaf` text NOT NULL,
	`leaf_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`verifier_run_id`) REFERENCES `verifier_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `checklist_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_run_leaf_uq` ON `evidence` (`verifier_run_id`,`leaf_index`);--> statement-breakpoint
CREATE INDEX `evidence_item_idx` ON `evidence` (`item_id`);--> statement-breakpoint
CREATE TABLE `quorum_certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`round` integer NOT NULL,
	`certificate` text NOT NULL,
	`certificate_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_job_round_uq` ON `quorum_certificates` (`job_id`,`round`);--> statement-breakpoint
CREATE TABLE `verifier_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`round` integer NOT NULL,
	`verifier_id` text NOT NULL,
	`browser` text NOT NULL,
	`judge_model` text NOT NULL,
	`deliverable_url` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`merkle_root` text,
	`leaf_count` integer,
	`attestation` text,
	`replay_url` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verifier_runs_round_uq` ON `verifier_runs` (`job_id`,`round`,`verifier_id`);--> statement-breakpoint
ALTER TABLE `checklist_items` ADD `verdict_reason` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `deliverable_url` text;