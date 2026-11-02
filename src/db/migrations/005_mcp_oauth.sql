-- MCP OAuth: the hub is an OAuth 2.1 authorization server for its MCP endpoints. People sign in through the
-- configured OIDC provider (Keycloak); a tenant decides which email domains / addresses may use its servers.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sso_allowed_domains JSONB NOT NULL DEFAULT '[]';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sso_allowed_emails JSONB NOT NULL DEFAULT '[]';

-- Clients registered through dynamic client registration (RFC 7591).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                   TEXT PRIMARY KEY,
  client_secret_hash          TEXT,
  client_name                 TEXT,
  redirect_uris               JSONB NOT NULL,
  grant_types                 JSONB NOT NULL,
  response_types              JSONB NOT NULL,
  token_endpoint_auth_method  TEXT NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An authorization in progress: the client's request, then the signed-in identity awaiting consent.
CREATE TABLE IF NOT EXISTS oauth_requests (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  state           TEXT,
  code_challenge  TEXT NOT NULL,
  scope           TEXT,
  resource        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  server_id       TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  oidc_secret_enc TEXT NOT NULL,
  user_id         TEXT,
  user_name       TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  resource        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  server_id       TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ
);

-- Access and refresh tokens (hashed). A refresh-token family rotates on every use; replaying a used refresh token
-- revokes the whole family.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   TEXT NOT NULL,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  server_id   TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  resource    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_tenant_user ON oauth_tokens (tenant_id, user_id);
