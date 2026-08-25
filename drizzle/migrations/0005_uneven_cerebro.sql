CREATE TABLE `payments` (
	`id` varchar(255) NOT NULL,
	`deployment_id` varchar(255) NOT NULL,
	`provider_type` varchar(50) NOT NULL,
	`provider_payment_id` varchar(255) NOT NULL,
	`amount` decimal(10,2) NOT NULL,
	`currency` varchar(10) NOT NULL DEFAULT 'EUR',
	`status` enum('pending','paid','failed','canceled','expired','authorized','unknown') NOT NULL DEFAULT 'pending',
	`checkout_url` varchar(1024),
	`paid_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_payments_deployment` ON `payments` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `idx_payments_provider_payment` ON `payments` (`provider_type`,`provider_payment_id`);