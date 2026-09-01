-- ==========================================
-- Phase 10 fix: Missing indexes (idempotent)
--
-- idx_deployments_gap was defined in the
-- Drizzle schema but never created by any
-- previous migration. This adds it safely.
-- ==========================================
SELECT IF(
  (SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deployments' AND INDEX_NAME = 'idx_deployments_gap') = 0,
  'Creating idx_deployments_gap',
  'idx_deployments_gap already exists'
) AS result;

CREATE INDEX IF NOT EXISTS idx_deployments_gap ON deployments(gap_id);
