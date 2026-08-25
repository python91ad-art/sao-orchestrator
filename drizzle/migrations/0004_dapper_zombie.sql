CREATE TABLE `deployment_providers` (
	`id` varchar(255) NOT NULL,
	`deployment_id` varchar(255) NOT NULL,
	`provider_type` enum('vercel','mollie') NOT NULL,
	`provider_config` json NOT NULL,
	`deployment_url` varchar(512),
	`status` enum('pending','active','failed','superseded') NOT NULL DEFAULT 'pending',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `deployment_providers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `queue_items` ADD `next_retry_at` datetime;--> statement-breakpoint
CREATE INDEX `idx_dp_deployment_provider_status` ON `deployment_providers` (`deployment_id`,`provider_type`,`status`);