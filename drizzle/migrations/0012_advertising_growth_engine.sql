-- ==========================================
-- Advertising & Growth Engine Completion
-- Additive safety/metrics/approval/optimization tables.
-- ==========================================

ALTER TABLE ad_campaigns
  MODIFY COLUMN status enum('PLANNED','DRAFT','ANALYSING','READY','WAITING_FOR_BUDGET','WAITING_FOR_CREDENTIALS','READY_TO_PUBLISH','ACTIVE','PAUSED','COMPLETED','FAILED','READY_FOR_APPROVAL','APPROVED','REJECTED','STOPPED') NOT NULL DEFAULT 'DRAFT';

ALTER TABLE ad_campaigns ADD COLUMN objective varchar(255) NULL;
ALTER TABLE ad_campaigns ADD COLUMN target_audience text NULL;
ALTER TABLE ad_campaigns ADD COLUMN offer varchar(512) NULL;
ALTER TABLE ad_campaigns ADD COLUMN call_to_action varchar(255) NULL;
ALTER TABLE ad_campaigns ADD COLUMN daily_limit decimal(12,2) NOT NULL DEFAULT '0.00';
ALTER TABLE ad_campaigns ADD COLUMN approved_spend_limit decimal(12,2) NOT NULL DEFAULT '0.00';
ALTER TABLE ad_campaigns ADD COLUMN approval_status varchar(32) NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE ad_campaigns ADD COLUMN optimization_status varchar(32) NOT NULL DEFAULT 'MONITOR';

CREATE TABLE IF NOT EXISTS ad_audience_research (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  research_json text NOT NULL,
  evidence_json text,
  source_hash varchar(64) NOT NULL UNIQUE,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_audience_research_deployment (deployment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_budget_ledger (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  campaign_id varchar(255),
  payment_id varchar(255),
  type varchar(32) NOT NULL,
  amount decimal(12,2) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'POSTED',
  idempotency_key varchar(255) NOT NULL UNIQUE,
  metadata text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_budget_ledger_deployment (deployment_id),
  INDEX idx_ad_budget_ledger_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_campaign_events (
  id varchar(255) PRIMARY KEY,
  campaign_id varchar(255) NOT NULL,
  creative_id varchar(255),
  event_type varchar(32) NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  amount decimal(12,2) NOT NULL DEFAULT '0.00',
  source varchar(32) NOT NULL DEFAULT 'INTERNAL',
  attribution varchar(32) NOT NULL DEFAULT 'UNKNOWN',
  idempotency_key varchar(255) NOT NULL UNIQUE,
  metadata text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_campaign_events_campaign (campaign_id),
  INDEX idx_ad_campaign_events_creative (creative_id),
  INDEX idx_ad_campaign_events_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_approvals (
  id varchar(255) PRIMARY KEY,
  deployment_id varchar(255) NOT NULL,
  campaign_id varchar(255) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  requested_budget decimal(12,2) NOT NULL,
  requested_channel varchar(50) NOT NULL,
  strategy text,
  approved_limit decimal(12,2) NOT NULL DEFAULT '0.00',
  approved_by varchar(255),
  decision_reason text,
  decided_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_approvals_deployment (deployment_id),
  INDEX idx_ad_approvals_campaign (campaign_id),
  INDEX idx_ad_approvals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_experiments (
  id varchar(255) PRIMARY KEY,
  campaign_id varchar(255) NOT NULL,
  hypothesis text NOT NULL,
  variable varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'DRAFT',
  control_creative_id varchar(255),
  variant_a_creative_id varchar(255),
  variant_b_creative_id varchar(255),
  metrics_json text,
  selected_creative_id varchar(255),
  decision_reason text,
  started_at datetime,
  ended_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_experiments_campaign (campaign_id),
  INDEX idx_ad_experiments_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_optimization_decisions (
  id varchar(255) PRIMARY KEY,
  campaign_id varchar(255) NOT NULL,
  decision varchar(64) NOT NULL,
  reason text NOT NULL,
  metrics_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_optimization_campaign (campaign_id),
  INDEX idx_ad_optimization_decision (decision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
