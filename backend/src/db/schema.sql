-- StellarYield backend schema

CREATE TABLE IF NOT EXISTS vaults (
  id              SERIAL PRIMARY KEY,
  contract_id     TEXT NOT NULL UNIQUE,
  factory_id      TEXT,
  asset           TEXT NOT NULL,
  name            TEXT,
  symbol          TEXT,
  state           TEXT NOT NULL DEFAULT 'Funding',
  total_assets    NUMERIC DEFAULT 0,
  total_supply    NUMERIC DEFAULT 0,
  total_shares_ever_minted NUMERIC NOT NULL DEFAULT 0,
  total_shares_ever_burned NUMERIC NOT NULL DEFAULT 0,
  early_redemption_fee_bps INT DEFAULT 0,
  expected_apy    INT,
  maturity_date   TIMESTAMPTZ,
  rwa_category    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  address         TEXT NOT NULL UNIQUE,
  kyc_verified    BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_vault_positions (
  id              SERIAL PRIMARY KEY,
  user_address    TEXT NOT NULL,
  vault_id        INT NOT NULL REFERENCES vaults(id),
  shares          NUMERIC DEFAULT 0,
  deposited       NUMERIC DEFAULT 0,
  last_claimed_epoch INT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_address, vault_id)
);

CREATE TABLE IF NOT EXISTS share_balance_snapshots (
  id              SERIAL PRIMARY KEY,
  user_address    TEXT NOT NULL,
  vault_id        INT NOT NULL REFERENCES vaults(id),
  epoch           INT NOT NULL,
  shares          NUMERIC NOT NULL DEFAULT 0,
  recorded_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_address, vault_id, epoch)
);

CREATE INDEX IF NOT EXISTS idx_share_balance_snapshots_user_vault_epoch
  ON share_balance_snapshots (user_address, vault_id, epoch);

CREATE INDEX IF NOT EXISTS idx_share_balance_snapshots_user_epoch
  ON share_balance_snapshots (user_address, epoch);

CREATE TABLE IF NOT EXISTS epochs (
  id              SERIAL PRIMARY KEY,
  vault_id        INT NOT NULL REFERENCES vaults(id),
  epoch           INT NOT NULL,
  yield_amount    NUMERIC NOT NULL,
  total_shares    NUMERIC NOT NULL,
  distributed_at  TIMESTAMPTZ,
  UNIQUE (vault_id, epoch)
);

CREATE TABLE IF NOT EXISTS indexed_events (
  id              SERIAL PRIMARY KEY,
  ledger          INT NOT NULL,
  tx_hash         TEXT NOT NULL,
  contract_id     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  id              SERIAL PRIMARY KEY,
  last_ledger     INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id              SERIAL PRIMARY KEY,
  url             TEXT NOT NULL,
  events          TEXT[] NOT NULL,
  secret          TEXT,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         SERIAL PRIMARY KEY,
  key_hash   TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'admin',
  label      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
