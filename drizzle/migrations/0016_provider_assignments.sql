CREATE TABLE IF NOT EXISTS provider_assignments (
 connection_id varchar(255) NOT NULL,
 section varchar(64) NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 priority int NOT NULL DEFAULT 100,
 fallback_order int NOT NULL DEFAULT 0,
 operation varchar(64) NOT NULL,
 model varchar(150),
 settings_json text NOT NULL,
 updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(connection_id, section),
 INDEX idx_assignment_section(section, enabled)
);
--> statement-breakpoint
SET @assignment_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integration_credentials' AND COLUMN_NAME='assignment_version')=0, 'ALTER TABLE integration_credentials ADD COLUMN assignment_version int NOT NULL DEFAULT 0', 'SELECT 1');
--> statement-breakpoint
PREPARE assignment_stmt FROM @assignment_ddl;
--> statement-breakpoint
EXECUTE assignment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE assignment_stmt;
