CREATE TABLE IF NOT EXISTS action_approvals (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  action varchar(128) NOT NULL,
  resource_id varchar(255) NOT NULL,
  authority varchar(32) NOT NULL,
  requested_by varchar(255) NOT NULL,
  risk varchar(32) NOT NULL,
  amount decimal(18,2),
  currency varchar(3),
  scope_json longtext NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  expires_at datetime NOT NULL,
  decided_by varchar(255),
  decided_at datetime,
  revoked_at datetime,
  execution_ref varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX approval_scope (deployment_id,action,status),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id varchar(255) PRIMARY KEY,
  agent_id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  tools_json longtext NOT NULL,
  expires_at datetime NOT NULL,
  revoked_at datetime,
  created_by varchar(255) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);
CREATE TABLE IF NOT EXISTS task_executions (
  id varchar(255) PRIMARY KEY,
  task_id varchar(255) NOT NULL,
  agent_id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  specification_version_id varchar(255),
  tool varchar(128) NOT NULL,
  status varchar(32) NOT NULL,
  attempt int NOT NULL,
  output_json longtext,
  error_message longtext,
  started_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at datetime,
  INDEX execution_task(task_id,started_at),
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);
CREATE TABLE IF NOT EXISTS release_authorizations (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  artifact_id varchar(255) NOT NULL,
  artifact_hash varchar(64) NOT NULL,
  specification_version_id varchar(255) NOT NULL,
  qc_job_id varchar(255) NOT NULL,
  builder_agent_id varchar(255) NOT NULL,
  qc_agent_id varchar(255) NOT NULL,
  architect_execution_id varchar(255) NOT NULL,
  policy_evaluation_id varchar(255),
  status varchar(32) NOT NULL,
  evidence_json longtext NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX release_business(deployment_id,created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id),
  FOREIGN KEY (artifact_id) REFERENCES build_artifacts(id),
  FOREIGN KEY (qc_job_id) REFERENCES qc_jobs(id)
);
CREATE TABLE IF NOT EXISTS accounting_items (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  economic_key varchar(255) NOT NULL UNIQUE,
  payment_id varchar(255),
  kind varchar(32) NOT NULL,
  amount decimal(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  occurred_at datetime NOT NULL,
  verified_by varchar(255),
  verified_at datetime,
  disputed boolean NOT NULL DEFAULT false,
  period_id varchar(255),
  evidence_json longtext NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX accounting_business_period(deployment_id,occurred_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);
CREATE TABLE IF NOT EXISTS accounting_periods (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  period_key varchar(255) NOT NULL UNIQUE,
  starts_at datetime NOT NULL,
  ends_at datetime NOT NULL,
  policy_version_id varchar(255) NOT NULL,
  authorization_id varchar(255),
  previous_period_id varchar(255),
  status varchar(32) NOT NULL,
  calculation_json longtext,
  reconciled_by varchar(255),
  reconciled_at datetime,
  settlement_id varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX period_business(deployment_id,ends_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id),
  FOREIGN KEY (policy_version_id) REFERENCES policy_versions(id),
  FOREIGN KEY (authorization_id) REFERENCES action_approvals(id),
  FOREIGN KEY (settlement_id) REFERENCES settlement_records(id)
);
CREATE TABLE IF NOT EXISTS price_proposals (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  amount decimal(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  previous_id varchar(255),
  status varchar(32) NOT NULL,
  risk varchar(32) NOT NULL,
  recommendation_json longtext NOT NULL,
  evidence_ids_json longtext NOT NULL,
  applied_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX pricing_business(deployment_id,created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);
CREATE TABLE IF NOT EXISTS extension_offers (
  id varchar(255) PRIMARY KEY,
  lifecycle_id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  price decimal(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  duration_days int NOT NULL,
  status varchar(32) NOT NULL,
  assessment_json longtext NOT NULL,
  expires_at datetime NOT NULL,
  accepted_by varchar(255),
  payment_id varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX extension_business(deployment_id,status),
  FOREIGN KEY (lifecycle_id) REFERENCES business_lifecycle_records(id),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);
CREATE TABLE IF NOT EXISTS operational_settings (
  setting_key varchar(128) PRIMARY KEY,
  value_json longtext NOT NULL,
  revision int NOT NULL DEFAULT 1,
  updated_by varchar(255) NOT NULL,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS operational_events (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255),
  actor_id varchar(255) NOT NULL,
  event_type varchar(128) NOT NULL,
  resource_id varchar(255),
  detail_json longtext NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX operation_history(deployment_id,created_at)
);
CREATE TABLE IF NOT EXISTS discovery_archives (
  gap_id varchar(255) PRIMARY KEY,
  reset_id varchar(255) NOT NULL,
  reason longtext NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (gap_id) REFERENCES gaps(id)
);
ALTER TABLE build_artifacts MODIFY COLUMN metadata_json LONGTEXT;
ALTER TABLE agent_tasks MODIFY COLUMN input_json LONGTEXT;
ALTER TABLE agent_tasks MODIFY COLUMN output_json LONGTEXT;
ALTER TABLE agent_tasks MODIFY COLUMN recovery_checkpoint_json LONGTEXT;
ALTER TABLE gap_policy_reviews MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE business_specification_versions MODIFY COLUMN sections_json LONGTEXT NOT NULL;
ALTER TABLE business_lifecycle_records MODIFY COLUMN final_report_json LONGTEXT;
