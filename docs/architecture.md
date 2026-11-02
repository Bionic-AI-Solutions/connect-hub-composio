# Architecture

```
            ┌──────────── tenant backend / agents ────────────┐          end user's browser
            │  REST /v1 (API key chk_…)    MCP /mcp (chm_…)   │      /connect/:id   /oauth/callback
            └───────────────┬──────────────────────┬──────────┘               │
                            ▼                      ▼                          ▼
   ┌───────────────────────────────────────────────────────────────────────────────────────┐
   │ http/app.ts  (Fastify: auth hooks, rate limit, hosted connect pages, MCP transport)   │
   ├──────────────┬──────────────────┬────────────────────┬──────────────────┬─────────────┤
   │ TenantService│ ConnectionService│ Executor           │ McpService       │ Registry    │
   │ api keys     │ auth configs     │ resolve account →  │ server configs,  │ toolkits &  │
   │              │ connect links    │ refresh → run tool │ per-user tokens, │ tools       │
   │              │ OAuth2 + PKCE    │ timeout, audit     │ direct/router    │             │
   │              │ token refresh    │ kv store           │ modes            │             │
   ├──────────────┴────────┬─────────┴────────────────────┴──────────────────┼─────────────┤
   │ Vault (AES-256-GCM, key rotation, HMAC for link/state signatures)       │ catalog     │
   ├─────────────────────────────────────────────────────────────────────────┤ adapters:   │
   │ Db: Postgres (prod) / PGlite (dev, tests) — same SQL                     │ activepieces│
   └─────────────────────────────────────────────────────────────────────────┘ + native    │
                                                                              └────────────┘
```

## Catalog

Every integration is normalized into a `Toolkit` (`src/catalog/types.ts`): auth schemes, tools with JSON Schema
inputs, `execute`, and optionally `listOptions`, `validate`, `identify`.

- **Activepieces adapter** (`src/catalog/activepieces.ts`) discovers every installed `@activepieces/piece-*`
  package. Pieces are self-contained bundles, so the adapter only reads their auth definitions and action props,
  converts props to JSON Schema, and runs `action.run(ctx)` with a small stand-in for the Activepieces engine
  context (auth, propsValue, store, files, server). Stored credentials use the same shape as Activepieces
  `AppConnectionValue`, so pieces consume them unchanged.
- **Native toolkits** (`src/catalog/native/`) fill gaps: Stack Exchange, Cloudflare, Google Analytics (GA4).
  A native toolkit with the same slug as a piece overrides it.

Every tool gets MCP annotations (`src/catalog/annotations.ts`): explicit ones from native toolkits, otherwise
inferred from the action name. A destructive verb anywhere → destructive; a leading read verb with no write verb →
read-only; generic escape hatches (`custom_api_call`, raw GraphQL) → destructive; everything else → write.

Tool slugs are `<toolkit>.<action>` (e.g. `github.github_create_issue`); MCP names replace `.` with `__`.

## Auth

- **Auth schemes** per toolkit: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`, `NO_AUTH`.
- **OAuth apps** resolve in this order: the auth config named on the link → the tenant's latest OAuth auth config for
  the toolkit (white-label) → the platform app for the provider family (`OAUTH_GOOGLE_*` covers every Google
  toolkit) → error `oauth_app_missing`.
- **Connect flow**: `POST /v1/connected-accounts/link` stores a connect request (PKCE verifier encrypted) and returns
  a signed `connect_url`. OAuth requests redirect straight to the provider (or first show a form when the provider
  needs fields such as a subdomain); other schemes show a credential form. The callback verifies the HMAC-signed
  `state`, exchanges the code with the PKCE verifier, stores the encrypted token, and redirects to the tenant's
  `redirect_url` with `status` and `connected_account_id`. Links are single-use and expire (default 30 min).
- **Validation**: non-OAuth credentials are checked against the provider (piece `validate` hooks) before they are
  stored.
- **Refresh**: tokens expiring within 5 minutes are refreshed before a tool runs; a background sweep refreshes
  tokens expiring within 15 minutes. `invalid_grant` marks the account `EXPIRED` so the agent asks the user to
  reconnect instead of retrying forever.

## Data model

`tenants`, `api_keys` (sha256 of secret; prefix lookup), `auth_configs` (client secret encrypted),
`connected_accounts` (credentials encrypted; status `ACTIVE`/`EXPIRED`/`FAILED`), `connect_requests`,
`mcp_servers`, `mcp_tokens` (hashed), `kv_store` (per-account state some actions keep between runs), `audit_log`.
Every query is scoped by `tenant_id`.

## Security model

- Credentials and OAuth client secrets are encrypted with AES-256-GCM; the key id is bound as AAD. `MASTER_KEYS`
  holds the active key plus retired keys; envelopes under a retired key are re-encrypted on next use. Replace
  `Vault` with a KMS-backed class for production key custody.
- API keys and MCP tokens are random 192-bit secrets stored as sha256 hashes, compared in constant time, revocable.
- Connect links and OAuth state are HMAC-signed; redirect targets must be in `ALLOWED_REDIRECT_ORIGINS` (localhost
  always allowed for development).
- Hosted pages send a strict CSP, `X-Frame-Options: DENY` and `no-referrer`; secrets are never echoed back.
- API responses never include credentials; logs redact `Authorization` headers.
- An MCP token is bound to one tenant, one server config and one end user; tools outside the config are refused.

## Known limits (MVP)

- Token refresh is de-duplicated per process only; with several replicas, add a row lock (`SELECT … FOR UPDATE
SKIP LOCKED`) around refresh.
- Activepieces triggers (webhooks/polling) are not wired up yet; only actions are exposed.
- Actions that pause runs or depend on Activepieces server endpoints (waitpoints, resume URLs) fail with a clear
  error.
- `files.write` returns a `data:` URL; large file outputs should go to object storage.
