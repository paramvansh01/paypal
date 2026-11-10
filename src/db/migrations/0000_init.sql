CREATE TABLE `checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`milestone_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`check_type` text NOT NULL,
	`params` text NOT NULL,
	`verdict` text,
	`evidence_id` text,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_milestone_position_uq` ON `checklist_items` (`milestone_id`,`position`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_job_idx` ON `events` (`job_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`summary` text NOT NULL,
	`measured_value` text,
	`screenshot_path` text,
	`replay_url` text,
	`raw` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `checklist_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`client_id` text NOT NULL,
	`worker_id` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`total_amount_cents` integer NOT NULL,
	`checklist_hash` text,
	`paypal_order_id` text,
	`rail` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_client_idx` ON `jobs` (`client_id`);--> statement-breakpoint
CREATE INDEX `jobs_worker_idx` ON `jobs` (`worker_id`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`paypal_capture_id` text,
	`paypal_release_id` text,
	`paypal_refund_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milestones_job_position_uq` ON `milestones` (`job_id`,`position`);--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`paypal_email` text,
	`paypal_merchant_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parties_paypal_email_kind_uq` ON `parties` (`paypal_email`,`kind`);