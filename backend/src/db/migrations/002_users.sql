CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  address         TEXT NOT NULL UNIQUE,
  kyc_verified    BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
