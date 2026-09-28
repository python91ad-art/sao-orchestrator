-- ==========================================
-- Generic Provider Registry & Credential Audit Logs
--
-- Adds integration_credentials and credential_audit_logs
-- tables for encrypted credential storage and audit trails.
-- ==========================================

CREATE TABLE IF NOT EXISTS integration_credentials (
  id varchar(255) PRIMARY KEY,
  service varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  provider_id varchar(128) NOT NULL DEFAULT 'custom',
  credential_type varchar(64) NOT NULL DEFAULT 'api_key',
  encrypted_value text NOT NULL,
  encryption_version int NOT NULL DEFAULT 1,
  base_url varchar(1024),
  config text,
  enabled boolean NOT NULL DEFAULT true,
  priority varchar(16),
  compatibility_status varchar(32) NOT NULL DEFAULT 'unknown',
  connection_status varchar(32) NOT NULL DEFAULT 'untested',
  last_tested_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_integration_credentials_service (service, provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credential_audit_logs (
  id varchar(255) PRIMARY KEY,
  user_id varchar(255),
  service varchar(64) NOT NULL,
  operation varchar(64) NOT NULL,
  success boolean NOT NULL DEFAULT true,
  message varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
