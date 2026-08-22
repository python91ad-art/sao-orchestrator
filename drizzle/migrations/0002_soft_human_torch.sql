CREATE TABLE `registration_invites` (
	`id` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`role` enum('admin','user') NOT NULL DEFAULT 'user',
	`created_by` varchar(255) NOT NULL,
	`expires_at` datetime,
	`used_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `registration_invites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `concurrency` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `queue_type` enum('synthesis','deployment','audit','maintenance') DEFAULT 'synthesis' NOT NULL;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `worker_id` varchar(255);