CREATE TABLE IF NOT EXISTS evidence_records (
  id varchar(255) NOT NULL,
  gap_id varchar(255),
  deployment_id varchar(255),
  business_spec_id varchar(255),
  provider varchar(128) NOT NULL,
  source_url varchar(2048),
  category varchar(128) NOT NULL DEFAULT 'market_context',
  title varchar(512),
  summary text NOT NULL,
  content text,
  retrieved_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at datetime,
  geography varchar(255),
  reporting_period varchar(255),
  metadata_json text,
  reliability_json text,
  caveats_json text,
  status varchar(64) NOT NULL DEFAULT 'collected',
  version int NOT NULL DEFAULT 1,
  dedup_hash varchar(64) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT evidence_records_id PRIMARY KEY(id),
  CONSTRAINT evidence_records_dedup_hash_unique UNIQUE(dedup_hash)
);

CREATE TABLE IF NOT EXISTS evidence_events (
  id varchar(255) NOT NULL,
  evidence_id varchar(255),
  gap_id varchar(255),
  provider varchar(128) NOT NULL,
  event_type varchar(64) NOT NULL,
  message text NOT NULL,
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT evidence_events_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS business_specifications (
  id varchar(255) NOT NULL,
  gap_id varchar(255),
  deployment_id varchar(255),
  current_version_id varchar(255),
  status varchar(64) NOT NULL DEFAULT 'draft',
  approval_state varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  title varchar(255) NOT NULL,
  legacy_business_plan text,
  created_by varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_specifications_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS business_specification_versions (
  id varchar(255) NOT NULL,
  specification_id varchar(255) NOT NULL,
  version_number int NOT NULL,
  status varchar(64) NOT NULL DEFAULT 'draft',
  sections_json text NOT NULL,
  change_summary text,
  created_by varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_specification_versions_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS business_specification_events (
  id varchar(255) NOT NULL,
  specification_id varchar(255) NOT NULL,
  version_id varchar(255),
  event_type varchar(64) NOT NULL,
  status varchar(64) NOT NULL DEFAULT 'open',
  title varchar(255) NOT NULL,
  detail text NOT NULL,
  metadata_json text,
  created_by varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_specification_events_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS agents (
  id varchar(255) NOT NULL,
  role varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  capability_json text NOT NULL,
  tool_metadata_json text,
  availability varchar(64) NOT NULL DEFAULT 'registered',
  implementation_status varchar(64) NOT NULL DEFAULT 'registered',
  health_status varchar(64) NOT NULL DEFAULT 'unknown',
  version varchar(64) NOT NULL DEFAULT '1',
  is_backup boolean NOT NULL DEFAULT false,
  backup_for_agent_id varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT agents_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id varchar(255) NOT NULL,
  parent_task_id varchar(255),
  agent_id varchar(255),
  gap_id varchar(255),
  deployment_id varchar(255),
  specification_id varchar(255),
  build_project_id varchar(255),
  task_type varchar(128) NOT NULL,
  title varchar(255) NOT NULL,
  state varchar(64) NOT NULL DEFAULT 'pending',
  input_json text,
  output_json text,
  error_message text,
  retry_count int NOT NULL DEFAULT 0,
  policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  idempotency_key varchar(255) NOT NULL,
  recovery_checkpoint_json text,
  created_by varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT agent_tasks_id PRIMARY KEY(id),
  CONSTRAINT agent_tasks_idempotency_key_unique UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id varchar(255) NOT NULL,
  task_id varchar(255) NOT NULL,
  depends_on_task_id varchar(255) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT task_dependencies_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id varchar(255) NOT NULL,
  agent_id varchar(255),
  task_id varchar(255),
  event_type varchar(64) NOT NULL,
  message text NOT NULL,
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT agent_events_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS build_projects (
  id varchar(255) NOT NULL,
  gap_id varchar(255),
  deployment_id varchar(255),
  specification_id varchar(255),
  project_type varchar(64) NOT NULL DEFAULT 'software',
  status varchar(64) NOT NULL DEFAULT 'draft',
  architecture_json text,
  frontend_workspace_json text,
  backend_workspace_json text,
  database_requirements_json text,
  integration_requirements_json text,
  environment_config_json text,
  policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT build_projects_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS build_artifacts (
  id varchar(255) NOT NULL,
  build_project_id varchar(255) NOT NULL,
  artifact_type varchar(64) NOT NULL,
  name varchar(255) NOT NULL,
  uri varchar(2048),
  version varchar(64) NOT NULL DEFAULT '1',
  content_hash varchar(128),
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT build_artifacts_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS build_logs (
  id varchar(255) NOT NULL,
  build_project_id varchar(255) NOT NULL,
  level varchar(32) NOT NULL DEFAULT 'info',
  message text NOT NULL,
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT build_logs_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS qc_jobs (
  id varchar(255) NOT NULL,
  build_project_id varchar(255),
  artifact_id varchar(255),
  assigned_agent_id varchar(255),
  status varchar(64) NOT NULL DEFAULT 'pending',
  release_decision varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  summary text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qc_jobs_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS qc_test_runs (
  id varchar(255) NOT NULL,
  qc_job_id varchar(255) NOT NULL,
  suite_name varchar(255) NOT NULL,
  test_name varchar(255) NOT NULL,
  status varchar(64) NOT NULL,
  evidence_json text,
  output text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qc_test_runs_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS defect_reports (
  id varchar(255) NOT NULL,
  qc_job_id varchar(255),
  build_project_id varchar(255),
  repair_task_id varchar(255),
  severity varchar(64) NOT NULL DEFAULT 'medium',
  status varchar(64) NOT NULL DEFAULT 'open',
  title varchar(255) NOT NULL,
  detail text NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT defect_reports_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS leads (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  source varchar(128) NOT NULL,
  name varchar(255),
  company varchar(255),
  email_hash varchar(64),
  status varchar(64) NOT NULL DEFAULT 'new',
  metadata_json text,
  dedup_hash varchar(64) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT leads_id PRIMARY KEY(id),
  CONSTRAINT leads_dedup_hash_unique UNIQUE(dedup_hash)
);

CREATE TABLE IF NOT EXISTS customers (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  lead_id varchar(255),
  name varchar(255),
  company varchar(255),
  email_hash varchar(64),
  status varchar(64) NOT NULL DEFAULT 'active',
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customers_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS sales_activities (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  lead_id varchar(255),
  customer_id varchar(255),
  activity_type varchar(64) NOT NULL,
  status varchar(64) NOT NULL DEFAULT 'recorded',
  notes text,
  attribution_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_activities_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS revenue_accounts (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  account_type varchar(64) NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'USD',
  status varchar(64) NOT NULL DEFAULT 'open',
  policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT revenue_accounts_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS revenue_transactions (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  payment_id varchar(255),
  customer_id varchar(255),
  account_id varchar(255),
  transaction_type varchar(64) NOT NULL,
  amount decimal(12,2) NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'USD',
  status varchar(64) NOT NULL DEFAULT 'recorded',
  idempotency_key varchar(255) NOT NULL,
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT revenue_transactions_id PRIMARY KEY(id),
  CONSTRAINT revenue_transactions_idempotency_key_unique UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS settlement_records (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  revenue_transaction_id varchar(255),
  settlement_type varchar(64) NOT NULL,
  amount decimal(12,2) NOT NULL DEFAULT '0.00',
  currency varchar(10) NOT NULL DEFAULT 'USD',
  status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT settlement_records_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS business_lifecycle_records (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  gap_id varchar(255),
  state varchar(64) NOT NULL DEFAULT 'monitoring',
  deadline_at datetime,
  deadline_policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  extension_policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  shutdown_policy_status varchar(64) NOT NULL DEFAULT 'POLICY_NOT_CONFIGURED',
  final_report_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_lifecycle_records_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS business_lifecycle_events (
  id varchar(255) NOT NULL,
  lifecycle_id varchar(255) NOT NULL,
  event_type varchar(64) NOT NULL,
  status varchar(64) NOT NULL DEFAULT 'recorded',
  detail text NOT NULL,
  metadata_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_lifecycle_events_id PRIMARY KEY(id)
);
