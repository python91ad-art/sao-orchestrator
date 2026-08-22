ALTER TABLE `core_loop_state` ADD `max_cost_per_day` decimal(10,2) DEFAULT '50.00' NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `max_deployments` int DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `auto_pause_on_high_ban_risk` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `email_notifications` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `core_loop_state` ADD `slack_notifications` boolean DEFAULT false NOT NULL;