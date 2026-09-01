-- ============================================================
-- Phase 11: Crypto-only payment system (NOWPayments)
-- Additive, idempotent, non-destructive migration.
--
-- The canonical production migration runner is `run-migration.js`
-- (invoked by `pnpm start`). This SQL file documents the same
-- additive changes for the drizzle-kit migration folder.
-- ============================================================

-- Make provider_payment_id nullable: the local payment record is
-- created first, and the provider payment id is stored after the
-- NOWPayments create-payment call succeeds.
ALTER TABLE `payments` MODIFY COLUMN `provider_payment_id` varchar(255) NULL;

-- Extend the controlled payment status model with the intermediate
-- crypto confirmation states. Historical enum values are preserved.
ALTER TABLE `payments` MODIFY COLUMN `status` enum('pending','confirming','confirmed','paid','failed','canceled','expired','authorized','unknown') NOT NULL DEFAULT 'pending';

-- Crypto-specific payment columns (provider-agnostic ledger stays reusable).
ALTER TABLE `payments` ADD COLUMN `crypto_amount` decimal(38,18) NULL;
ALTER TABLE `payments` ADD COLUMN `crypto_currency` varchar(20) NULL;
ALTER TABLE `payments` ADD COLUMN `crypto_network` varchar(50) NULL;
ALTER TABLE `payments` ADD COLUMN `payment_address` varchar(255) NULL;
ALTER TABLE `payments` ADD COLUMN `transaction_hash` varchar(255) NULL;
ALTER TABLE `payments` ADD COLUMN `provider_status` varchar(50) NULL;
ALTER TABLE `payments` ADD COLUMN `expires_at` datetime NULL;
