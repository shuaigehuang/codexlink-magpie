CREATE TABLE IF NOT EXISTS desktop_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  bound_device_id TEXT,
  source TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_desktop_tokens_hash
  ON desktop_tokens (token_hash);

CREATE TABLE IF NOT EXISTS mobile_sessions (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scopes TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_device
  ON mobile_sessions (device_id);

CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pair_codes_expiry
  ON pair_codes (expires_at);
