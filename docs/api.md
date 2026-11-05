# API reference

Tenant endpoints take `Authorization: Bearer chk_…` (or `x-api-key`). Errors are `{"error": {"code", "message", "details"}}`.

## Admin (`Authorization: Bearer $ADMIN_TOKEN`)

| Method | Path                           | Body                                                 | Result                               |
| ------ | ------------------------------ | ---------------------------------------------------- | ------------------------------------ |
| POST   | `/admin/tenants`               | `{name}`                                             | `{tenant, api_key}` (key shown once) |
| GET    | `/admin/tenants`               |                                                      | `{items}`                            |
| POST   | `/admin/tenants/:id/api-keys`  | `{name?}`                                            | `{id, api_key}`                      |
| POST   | `/admin/tenants/:id/copy-from` | `{source_tenant_id, toolkits?, user_map?, dry_run?}` | `{dry_run, auth_configs, accounts}`  |

### Copying one tenant's apps and accounts into another

`POST /admin/tenants/:id/copy-from` copies the source tenant's auth configs (OAuth apps) and its `ACTIVE` connected
accounts into tenant `:id`. Use it when two client companies run on the same underlying app accounts (the same
person's Gmail, GitHub, …). Each secret is decrypted with the source tenant's key and re-encrypted with the
target's.

- `toolkits` limits the copy to those slugs. Leave it out to copy every toolkit.
- `user_map` renames users, for example `{"me@a.com": "me@b.com"}`.
- `dry_run: true` reports without writing.

An auth config with the same toolkit, scheme and client is not copied again, and neither is an `ACTIVE` account
with the same user, toolkit and identifier. This applies to rows already in the target and to rows earlier in the
same run. So the call is safe to repeat, and a run that fails part-way is completed by running it again. Run one
copy at a time.

The result lists each item as `copied`, `exists`, `would_copy` or `skipped`. It never contains credentials.
Triggers and per-account action state are not copied. The target's audit log records `account.copied` for each
account and `tenant.copy` for each run, with the source tenant in `tool` (`from:<tenant>`).

**Refresh tokens.** An OAuth copy (`shares_refresh_token: true` in the result) shares the source account's refresh
token. Both copies keep working with providers whose refresh tokens can be reused, such as Google. Some providers
rotate refresh tokens, so each one works only once (Atlassian, for example). With those, the tenant that refreshes
first keeps the account, and the other tenant's copy, which can be the source's, turns `EXPIRED`. The user then
reconnects in that tenant. Exclude such toolkits with `toolkits`, or reconnect them in the target instead.

```bash
HUB_URL=https://connect.example.com ADMIN_TOKEN=… node scripts/hubctl.mjs tenant:copy <from_tenant> <to_tenant> --dry-run
HUB_URL=https://connect.example.com ADMIN_TOKEN=… node scripts/hubctl.mjs tenant:copy <from_tenant> <to_tenant> \
  --toolkits=gmail,google-drive --map=me@a.com=me@b.com
```

## Catalog

| Method | Path                                   | Notes                                                                                                            |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/toolkits?search=&category=`       | summaries with auth scheme types and tool counts                                                                 |
| GET    | `/v1/toolkits/:slug`                   | auth schemes (fields, scopes) and tool list                                                                      |
| GET    | `/v1/tools?toolkit=a,b&search=&limit=` | keyword search                                                                                                   |
| GET    | `/v1/tools/:slug`                      | `input_schema`, `dynamic_inputs`                                                                                 |
| POST   | `/v1/tools/:slug/execute`              | `{user_id, arguments, connected_account_id?}` → `{successful, data \| error, connected_account_id, duration_ms}` |
| POST   | `/v1/tools/:slug/options`              | `{user_id, input, arguments?}` → `{options}` for dropdowns or `{schema}` for dynamic inputs                      |

Execution error codes: `invalid_input`, `connection_required`, `account_not_active`, `provider_error`,
`tool_timeout`, `execution_error`.

## Apps and one-time sign-in setup

The dashboard's Apps page uses these. Set an OAuth app up once per provider (Google covers Gmail, Drive, Sheets,
YouTube…); everyone in the tenant then connects by signing in.

| Method | Path                            | Body / query                 | Result                                                                                               |
| ------ | ------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/v1/apps?user_id=`             |                              | per app: `connect` (`oauth` \| `form` \| `setup_required` \| `none`), `oauth_source`, account counts |
| GET    | `/v1/oauth-providers`           |                              | per provider: console link, callback URL, scopes, apps, `source` (`tenant` \| `platform` \| `none`)  |
| PUT    | `/v1/oauth-providers/:provider` | `{client_id, client_secret}` | one OAuth app for every app of that provider (secret encrypted, never returned)                      |
| DELETE | `/v1/oauth-providers/:provider` |                              | removes the tenant's app; sign-in falls back to the platform app, if set                             |

`redirect_url` on a connect link may always point back to the hub itself (the dashboard returns there after sign-in).

## Auth configs

| Method | Path                        | Body                                                                                            |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------- |
| POST   | `/v1/auth-configs`          | `{toolkit, scheme?, client_id?, client_secret?, scopes?}` — omit client to use the platform app |
| GET    | `/v1/auth-configs?toolkit=` |                                                                                                 |
| DELETE | `/v1/auth-configs/:id`      |                                                                                                 |

## Connected accounts

| Method | Path                                               | Body / query                                                                                             |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/connected-accounts/link`                      | `{user_id, toolkit, scheme?, auth_config_id?, redirect_url?}` → `{id, connect_url, expires_at, scheme}`  |
| POST   | `/v1/connected-accounts`                           | `{user_id, toolkit, scheme?, credentials}` — server-side import of API-key style credentials (validated) |
| GET    | `/v1/connected-accounts?user_id=&toolkit=&status=` |                                                                                                          |
| GET    | `/v1/connected-accounts/:id`                       |                                                                                                          |
| POST   | `/v1/connected-accounts/:id/refresh`               | force OAuth refresh                                                                                      |
| DELETE | `/v1/connected-accounts/:id`                       |                                                                                                          |

After a hosted connect the browser is redirected to `redirect_url?status=success&connected_account_id=…`.

## MCP

| Method | Path                         | Body                                                                                                           |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/mcp-servers`            | `{name, toolkits: [...], tools?: [...], mode: "direct" \| "router", connect_handoff: "text" \| "elicitation"}` |
| GET    | `/v1/mcp-servers`            |                                                                                                                |
| DELETE | `/v1/mcp-servers/:id`        |                                                                                                                |
| POST   | `/v1/mcp-servers/:id/tokens` | `{user_id}` → `{id, url, token}`                                                                               |
| DELETE | `/v1/mcp-tokens/:id`         | revoke                                                                                                         |

MCP endpoint: `POST /mcp` with `Authorization: Bearer chm_…` (streamable HTTP, stateless). Hub tools on every
server: `hub_list_connections`, `hub_connect`, `hub_list_options`; router mode adds `hub_search_tools`,
`hub_get_tool_schema` and three run tools, each limited to one risk class so a client can govern by tool name:
`hub_read` (read-only tools only), `hub_execute` (writes; refuses destructive tools) and
`hub_execute_destructive` (destructive tools only, including raw API calls).

Every tool carries MCP annotations (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) taken from the piece's own READ/SEARCH/WRITE/DESTRUCTIVE label when it has one, otherwise
inferred from the action name; a destructive verb or a raw API call always counts as destructive (see
`src/catalog/annotations.ts`); `GET /v1/tools/:slug` returns
them too.

`connect_handoff` controls what happens when the bound user has not connected the app: `text` (default) returns
an `isError` result containing the connect link; `elicitation` returns a JSON-RPC error `-32042`
(URL elicitation required) with `data.elicitations[0] = {mode: "url", elicitationId, url, message}`.

## MCP OAuth

Each MCP server's own endpoint is `/mcp/s/:serverId`. It accepts that server's `chm_` tokens and OAuth access
tokens (`cha_…`). Without a valid token it answers 401 with
`WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp/s/:serverId"`.

| Method  | Path                                                    | Notes                                                                                                               |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET     | `/.well-known/oauth-protected-resource/mcp/s/:serverId` | RFC 9728                                                                                                            |
| GET     | `/.well-known/oauth-authorization-server`               | RFC 8414                                                                                                            |
| POST    | `/oauth2/register`                                      | RFC 7591 dynamic client registration (`token_endpoint_auth_method` none / client_secret_post / client_secret_basic) |
| GET     | `/oauth2/authorize`                                     | code + PKCE S256 + `resource` (the server URL) required; sign-in through the OIDC provider, then consent            |
| POST    | `/oauth2/token`                                         | `authorization_code` (with `code_verifier`) and `refresh_token` (rotating; replay revokes the grant)                |
| POST    | `/oauth2/revoke`                                        | RFC 7009                                                                                                            |
| GET/PUT | `/v1/settings/sso`                                      | `{allowed_domains: [...], allowed_emails: [...]}`: who may sign in for this tenant                                  |
| GET     | `/v1/mcp-oauth-grants?user_id=`                         | active grants                                                                                                       |
| DELETE  | `/v1/mcp-oauth-grants/:id`                              | revoke a grant                                                                                                      |
| PUT     | `/admin/tenants/:id/sso`                                | operator sets a tenant's sign-in policy                                                                             |

## Triggers

| Method | Path                                          | Body / notes                                                                                                                                     |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/triggers?toolkit=a,b`                    | available triggers (`strategy`: POLLING or WEBHOOK)                                                                                              |
| GET    | `/v1/triggers/:slug`                          | `input_schema`, `sample_data`                                                                                                                    |
| POST   | `/v1/trigger-subscriptions`                   | `{trigger, user_id, webhook_url, config?, connected_account_id?, poll_interval_seconds?}` → `{subscription, signing_secret}` (secret shown once) |
| GET    | `/v1/trigger-subscriptions?user_id=`          |                                                                                                                                                  |
| GET    | `/v1/trigger-subscriptions/:id`               |                                                                                                                                                  |
| GET    | `/v1/trigger-subscriptions/:id/events?limit=` | delivery status per event (payloads are not kept)                                                                                                |
| DELETE | `/v1/trigger-subscriptions/:id`               | unregisters with the provider → `{provider_cleanup: "ok" \| "failed"}`                                                                           |

Deliveries are `POST <webhook_url>` with JSON `{id, type: "trigger.event", subscription_id, trigger, toolkit, user_id,
connected_account_id, created_at, data}` and headers `X-Hub-Event-Id`, `X-Hub-Timestamp` and
`X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Delivery is at least once:
dedupe on the event id. A failed delivery is retried with exponential backoff, 6 attempts in all. `webhook_url`
must be public https.

Providers call `POST|GET /hooks/:subscriptionId/:token` (public; the token is secret).

## Usage, limits and branding

| Method  | Path                              | Notes                                                                     |
| ------- | --------------------------------- | ------------------------------------------------------------------------- |
| GET     | `/v1/usage?period=YYYY-MM`        | `{tool_calls, failed_calls, trigger_events, limits}`                      |
| GET/PUT | `/v1/settings/branding`           | `{display_name, logo_url (https), accent_color (#rrggbb), support_email}` |
| PUT     | `/admin/tenants/:id/limits`       | `{rate_limit_per_minute, monthly_tool_call_limit}` (null = unlimited)     |
| GET     | `/admin/usage?period=&format=csv` | billing export across tenants                                             |

Calls over a limit fail with `rate_limited` (with `retry_after_seconds`) or `quota_exceeded`, and are not billed.

## Dashboard

`/dashboard`: sign in with a tenant API key.

## Audit

`GET /v1/audit-logs?user_id=&limit=` — one row per tool execution.
