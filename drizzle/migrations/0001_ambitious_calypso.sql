ALTER TABLE `core_loop_state` ADD `max_attempts` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `backoff_multiplier` decimal(3,1) DEFAULT '1.5' NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `base_delay_ms` int DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `queue_max_size` int DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `queue_expiration_hours` int DEFAULT 72 NOT NULL;