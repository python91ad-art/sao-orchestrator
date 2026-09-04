-- ==========================================
-- Registration invite token support
--
-- Adds a SHA-256 token hash for invitation-specific
-- registration URLs. Nullable initially so existing
-- invitation rows remain compatible.
-- ==========================================

ALTER TABLE registration_invites
  ADD COLUMN token_hash varchar(64) NULL;

CREATE UNIQUE INDEX idx_registration_invites_token_hash
  ON registration_invites(token_hash);
