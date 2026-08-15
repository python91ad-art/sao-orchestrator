-- SAO Migration - All 9 tables
-- Paste this into Railway's MySQL query console

CREATE TABLE `audit_logs` (
	`id` varchar(255) NOT NULL,
	`deployment_id` varchar(255),
	`gap_id` varchar(255),
	`decision` varchar(255) NOT NULL,
	`reasoning` text NOT NULL,
	`explanation` text NOT NULL,
	`ban_risk` enum('low','medium','high') NOT NULL DEFAULT 'low',
	`business_health` enum('healthy','warning','critical'),
	`timestamp` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);

CREATE TABLE `core_loop_state` (
	`id` varchar(255) NOT NULL DEFAULT 'singleton',
	`is_running` boolean NOT NULL DEFAULT false,
	`interval_ms` int NOT NULL DEFAULT 10800000,
	`last_executed_at` datetime,
	`next_execution_at` datetime,
	`total_gaps_processed` int NOT NULL DEFAULT 0,
	`total_deployments_created` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `core_loop_state_id` PRIMARY KEY(`id`)
);

CREATE TABLE `deployment_health_checks` (
	`id` varchar(255) NOT NULL,
	`deployment_id` varchar(255) NOT NULL,
	`revenue` decimal(10,2) NOT NULL,
	`ban_risk` enum('low','medium','high') NOT NULL,
	`health` enum('healthy','warning','critical') NOT NULL,
	`action` text,
	`success` boolean NOT NULL DEFAULT true,
	`checked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `deployment_health_checks_id` PRIMARY KEY(`id`)
);

CREATE TABLE `deployments` (
	`id` varchar(255) NOT NULL,
	`gap_id` varchar(255) NOT NULL,
	`status` enum('active','paused','stopped') NOT NULL DEFAULT 'active',
	`business_plan` text,
	`revenue` decimal(10,2) NOT NULL DEFAULT '0.00',
	`cost_per_day` decimal(10,2) NOT NULL DEFAULT '0.00',
	`ban_risk` enum('low','medium','high') NOT NULL DEFAULT 'low',
	`health` enum('healthy','warning','critical') NOT NULL DEFAULT 'healthy',
	`stripe_product_id` varchar(255),
	`stripe_price_id` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `deployments_id` PRIMARY KEY(`id`)
);

CREATE TABLE `gaps` (
	`id` varchar(255) NOT NULL,
	`knows` text NOT NULL,
	`needs` text NOT NULL,
	`controls_access` text NOT NULL,
	`underestimates_value` text NOT NULL,
	`source` varchar(255) NOT NULL,
	`status` enum('pending','processing','safe','unsafe','gray','false','deployed','failed') NOT NULL DEFAULT 'pending',
	`priority` int NOT NULL DEFAULT 5,
	`dedup_hash` varchar(255) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `gaps_id` PRIMARY KEY(`id`),
	CONSTRAINT `gaps_dedup_hash_unique` UNIQUE(`dedup_hash`)
);

CREATE TABLE `policies` (
	`id` varchar(255) NOT NULL,
	`rule_text` text NOT NULL,
	`acknowledged_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `policies_id` PRIMARY KEY(`id`)
);

CREATE TABLE `queue_items` (
	`id` varchar(255) NOT NULL,
	`gap_id` varchar(255) NOT NULL,
	`status` enum('pending','processing','paused','completed','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 3,
	`last_error` text,
	`dedup_hash` varchar(255) NOT NULL,
	`priority` int NOT NULL DEFAULT 5,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `queue_items_id` PRIMARY KEY(`id`)
);

CREATE TABLE `recurring_actors` (
	`id` varchar(255) NOT NULL,
	`actor_hash` varchar(255) NOT NULL,
	`frequency` int NOT NULL DEFAULT 1,
	`last_seen` datetime NOT NULL,
	`pattern` text,
	`anonymized_id` varchar(255) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `recurring_actors_id` PRIMARY KEY(`id`),
	CONSTRAINT `recurring_actors_actor_hash_unique` UNIQUE(`actor_hash`)
);

CREATE TABLE `users` (
	`id` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('admin','user') NOT NULL DEFAULT 'user',
	`reset_code` varchar(255),
	`reset_code_expiry` datetime,
	`last_signed_in` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);

-- Seed core loop state
INSERT INTO `core_loop_state` (`id`, `is_running`, `interval_ms`, `total_gaps_processed`, `total_deployments_created`) 
VALUES ('singleton', false, 10800000, 0, 0);
