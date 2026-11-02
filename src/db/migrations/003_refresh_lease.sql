-- Cross-replica token refresh lease. Many providers rotate refresh tokens (a used one stops working), so two
-- replicas refreshing the same account at once would make one of them fail with invalid_grant and wrongly mark the
-- account EXPIRED. Whoever sets this column first refreshes; the others wait and then read the new token.
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS refresh_lock_until TIMESTAMPTZ;
