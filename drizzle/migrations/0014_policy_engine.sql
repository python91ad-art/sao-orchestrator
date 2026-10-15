CREATE TABLE IF NOT EXISTS policy_versions (
 id varchar(255) PRIMARY KEY,
 category varchar(64) NOT NULL,
 config_json longtext NOT NULL,
 status varchar(32) NOT NULL DEFAULT 'draft',
 previous_id varchar(255),
 actor_id varchar(255) NOT NULL,
 reason text NOT NULL,
 validation_json longtext,
 impact_json longtext,
 created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 INDEX policy_category_created (category, created_at),
 FOREIGN KEY (previous_id) REFERENCES policy_versions(id)
);
CREATE TABLE IF NOT EXISTS policy_heads (
 category varchar(64) PRIMARY KEY,
 active_version_id varchar(255),
 updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (active_version_id) REFERENCES policy_versions(id)
);
CREATE TABLE IF NOT EXISTS policy_assignments (
 deployment_id varchar(255) NOT NULL,
 category varchar(64) NOT NULL,
 version_id varchar(255) NOT NULL,
 created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (deployment_id, category),
 FOREIGN KEY (deployment_id) REFERENCES deployments(id),
 FOREIGN KEY (version_id) REFERENCES policy_versions(id)
);
CREATE TABLE IF NOT EXISTS policy_evaluations (
 id varchar(255) PRIMARY KEY,
 category varchar(64) NOT NULL,
 version_id varchar(255),
 action varchar(128) NOT NULL,
 deployment_id varchar(255),
 gap_id varchar(255),
 decision varchar(64) NOT NULL,
 reason text NOT NULL,
 evidence_json longtext NOT NULL,
 actor_id varchar(255) NOT NULL,
 created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 INDEX policy_activity (category, created_at),
 INDEX policy_business (deployment_id),
 FOREIGN KEY (version_id) REFERENCES policy_versions(id)
);
CREATE TABLE IF NOT EXISTS admin_permissions (
 user_id varchar(255) NOT NULL,
 permission varchar(64) NOT NULL,
 PRIMARY KEY (user_id, permission),
 FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS discovery_reset_reports (
 id varchar(255) PRIMARY KEY,
 actor_id varchar(255) NOT NULL,
 report_json longtext NOT NULL,
 created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gap_policy_reviews (
 id varchar(255) PRIMARY KEY,
 gap_id varchar(255) NOT NULL,
 legal_state varchar(32) NOT NULL,
 complexity varchar(32) NOT NULL,
 demand_score decimal(12,4) NOT NULL,
 severity_score decimal(12,4) NOT NULL,
 evidence_score decimal(12,4) NOT NULL,
 solution_score decimal(12,4) NOT NULL,
 evidence_ids_json longtext NOT NULL,
 rationale text NOT NULL,
 actor_id varchar(255) NOT NULL,
 created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 INDEX gap_review (gap_id, created_at),
 FOREIGN KEY (gap_id) REFERENCES gaps(id)
);
