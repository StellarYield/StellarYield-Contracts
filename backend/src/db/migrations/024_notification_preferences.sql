-- Migration 024: Per-user, per-event-type notification preferences (#988).
--
-- Lets a user opt in / out of a specific event_type on a specific channel,
-- optionally scoped to a single vault. A NULL vault_contract_id means the
-- preference applies to every vault.

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  id                SERIAL PRIMARY KEY,
  user_address      TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  channel           TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  vault_contract_id TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One preference row per (user, event_type, channel, vault) combination.
-- A plain UNIQUE constraint treats NULLs as distinct, which would allow
-- duplicate "all vaults" rows, so COALESCE the nullable vault id.
CREATE UNIQUE INDEX IF NOT EXISTS user_notification_preferences_unique_idx
  ON user_notification_preferences (
    user_address, event_type, channel, COALESCE(vault_contract_id, '')
  );

CREATE INDEX IF NOT EXISTS user_notification_preferences_user_idx
  ON user_notification_preferences (user_address);
