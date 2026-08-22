CREATE TABLE `credential_audit_logs` (
	`id` varchar(255) NOT NULL,
	`user_id` varchar(255),
	`service` varchar(64) NOT NULL,
	`operation` varchar(64) NOT NULL,
	`success` boolean NOT NULL DEFAULT true,
	`message` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `credential_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `integration_credentials` (
	`id` varchar(255) NOT NULL,
	`service` varchar(64) NOT NULL,
	`encrypted_value` text NOT NULL,
	`encryption_version` int NOT NULL DEFAULT 1,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `integration_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_credentials_service_unique` UNIQUE(`service`)
);
--> statement-breakpoint
ALTER TABLE `queue_items` ADD `next_retry_at` datetime;