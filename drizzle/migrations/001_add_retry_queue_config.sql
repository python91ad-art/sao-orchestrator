-- SAO Migration: Add retry config and queue limit columns to core_loop_state
-- Run this against your Railway MySQL database

ALTER TABLE core_loop_state 
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS backoff_multiplier DECIMAL(3,1) NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS base_delay_ms INT NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS queue_max_size INT NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS queue_expiration_hours INT NOT NULL DEFAULT 72;
