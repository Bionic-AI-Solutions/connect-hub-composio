-- Bind an authorization in progress to the browser that started it (login-CSRF / request-forgery defence), and
-- remember which token family an authorization code produced so a replayed code revokes it (OAuth 2.1 §4.1.2).
ALTER TABLE oauth_requests ADD COLUMN IF NOT EXISTS browser_nonce_hash TEXT;
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS issued_family_id TEXT;
