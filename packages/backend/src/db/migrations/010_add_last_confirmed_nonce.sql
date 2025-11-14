-- Migration: Add lastConfirmedNonce column to accounts table
-- Purpose: Track the last confirmed on-chain nonce to help detect stuck transactions
-- and prevent nonce gaps in EVM chains
--
-- This migration adds lastConfirmedNonce column to track the highest nonce
-- that has been confirmed on-chain for each account. This helps identify
-- stuck transactions and prevent nonce gaps.
--
-- The migration runner (migrate.ts) will check if the column exists before
-- running this ALTER TABLE statement.

ALTER TABLE accounts ADD COLUMN lastConfirmedNonce INTEGER;
