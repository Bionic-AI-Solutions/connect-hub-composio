-- A tenant's subscription to an app event (new email, new PR…) for one end user, delivered to the tenant's webhook.
CREATE TABLE IF NOT EXISTS trigger_subscriptions (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  connected_account_id  TEXT,
  toolkit               TEXT NOT NULL,
  trigger               TEXT NOT NULL,
  strategy              TEXT NOT NULL,
  config_enc            TEXT NOT NULL,
  webhook_url           TEXT NOT NULL,
  signing_secret_enc    TEXT NOT NULL,
  hook_token_hash       TEXT NOT NULL,
  hook_token_enc        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
  next_run_at           TIMESTAMPTZ,
  renew_at              TIMESTAMPTZ,
  lease_until           TIMESTAMPTZ,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  last_run_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_subscriptions_due ON trigger_subscriptions (status, strategy, next_run_at);
CREATE INDEX IF NOT EXISTS trigger_subscriptions_tenant ON trigger_subscriptions (tenant_id, user_id);

-- Outbox of events to deliver. Payloads are encrypted and dropped once delivered.
CREATE TABLE IF NOT EXISTS trigger_events (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  subscription_id  TEXT NOT NULL REFERENCES trigger_subscriptions(id) ON DELETE CASCADE,
  tenant_id        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  attempts         INTEGER NOT NULL DEFAULT 0,
  payload_enc      TEXT,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trigger_events_due ON trigger_events (status, next_attempt_at, seq);
CREATE INDEX IF NOT EXISTS trigger_events_subscription ON trigger_events (subscription_id, created_at DESC);
