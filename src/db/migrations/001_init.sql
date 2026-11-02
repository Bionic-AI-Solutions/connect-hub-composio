CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- How a tenant authenticates against a toolkit: its own OAuth app (white-label) or the platform's.
CREATE TABLE IF NOT EXISTS auth_configs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  toolkit            TEXT NOT NULL,
  scheme             TEXT NOT NULL,
  use_platform_app   BOOLEAN NOT NULL DEFAULT true,
  client_id          TEXT,
  client_secret_enc  TEXT,
  scopes             JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_configs_tenant_toolkit ON auth_configs (tenant_id, toolkit);

-- One end-user's credential for one toolkit. Credentials are encrypted at rest.
CREATE TABLE IF NOT EXISTS connected_accounts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  toolkit          TEXT NOT NULL,
  scheme           TEXT NOT NULL,
  auth_config_id   TEXT REFERENCES auth_configs(id) ON DELETE SET NULL,
  status           TEXT NOT NULL,
  credentials_enc  TEXT,
  identifier       TEXT,
  expires_at       TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connected_accounts_lookup ON connected_accounts (tenant_id, user_id, toolkit, status);
CREATE INDEX IF NOT EXISTS connected_accounts_expiry ON connected_accounts (status, expires_at);

-- A pending hosted-connect flow (OAuth redirect or credential form).
CREATE TABLE IF NOT EXISTS connect_requests (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  toolkit               TEXT NOT NULL,
  scheme                TEXT NOT NULL,
  auth_config_id        TEXT REFERENCES auth_configs(id) ON DELETE SET NULL,
  secret_enc            TEXT NOT NULL,
  redirect_url          TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,
  connected_account_id  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  toolkits    JSONB NOT NULL,
  tools       JSONB,
  mode        TEXT NOT NULL DEFAULT 'direct',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  server_id   TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- Key/value store some actions use between runs (context.store), scoped per connected account.
CREATE TABLE IF NOT EXISTS kv_store (
  tenant_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB,
  PRIMARY KEY (tenant_id, scope, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  user_id               TEXT,
  action                TEXT NOT NULL,
  toolkit               TEXT,
  tool                  TEXT,
  connected_account_id  TEXT,
  status                TEXT NOT NULL,
  duration_ms           INTEGER,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_time ON audit_log (tenant_id, created_at DESC);
