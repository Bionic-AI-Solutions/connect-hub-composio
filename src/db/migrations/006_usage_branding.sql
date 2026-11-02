-- Per-tenant plan limits (NULL = unlimited), branding for hosted pages, and usage metering for billing.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS monthly_tool_call_limit INTEGER;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS usage_monthly (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,
  tool_calls      BIGINT NOT NULL DEFAULT 0,
  failed_calls    BIGINT NOT NULL DEFAULT 0,
  trigger_events  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);

-- Fixed one-minute windows, shared by all replicas.
CREATE TABLE IF NOT EXISTS rate_windows (
  tenant_id     TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  n             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, window_start)
);
