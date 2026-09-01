-- ==========================================
-- Phase 13: Advertising System
-- Additive: ad_campaigns + ad_creatives tables
-- ==========================================

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id VARCHAR(255) PRIMARY KEY,
  deployment_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  status ENUM('DRAFT','ANALYSING','READY','WAITING_FOR_BUDGET','WAITING_FOR_CREDENTIALS','READY_TO_PUBLISH','ACTIVE','PAUSED','COMPLETED','FAILED') NOT NULL DEFAULT 'DRAFT',
  campaign_type ENUM('PAID','FREE_ORGANIC') NOT NULL DEFAULT 'PAID',
  budget DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  spent DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  revenue_attributed DECIMAL(12,2) DEFAULT 0.00,
  strategy TEXT,
  provider_campaign_id VARCHAR(255),
  provider_status VARCHAR(100),
  error_message TEXT,
  started_at DATETIME,
  ended_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ad_campaigns_deployment (deployment_id),
  INDEX idx_ad_campaigns_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_creatives (
  id VARCHAR(255) PRIMARY KEY,
  campaign_id VARCHAR(255) NOT NULL,
  format VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  headline VARCHAR(255),
  call_to_action VARCHAR(100),
  target_audience VARCHAR(512),
  variation INT DEFAULT 1,
  provider_creative_id VARCHAR(255),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_creatives_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
