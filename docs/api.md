# API reference

Tenant endpoints take `Authorization: Bearer chk_…` (or `x-api-key`). Errors are `{"error": {"code", "message", "details"}}`.

## Admin (`Authorization: Bearer $ADMIN_TOKEN`)

| Method | Path                          | Body      | Result                               |
| ------ | ----------------------------- | --------- | ------------------------------------ |
| POST   | `/admin/tenants`              | `{name}`  | `{tenant, api_key}` (key shown once) |
| GET    | `/admin/tenants`              |           | `{items}`                            |
| POST   | `/admin/tenants/:id/api-keys` | `{name?}` | `{id, api_key}`                      |

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
`hub_get_tool_schema`, `hub_execute`.

Every tool carries MCP annotations (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) inferred from the action name (see `src/catalog/annotations.ts`); `GET /v1/tools/:slug` returns
them too.

`connect_handoff` controls what happens when the bound user has not connected the app: `text` (default) returns
an `isError` result containing the connect link; `elicitation` returns a JSON-RPC error `-32042`
(URL elicitation required) with `data.elicitations[0] = {mode: "url", elicitationId, url, message}`.

## Audit

`GET /v1/audit-logs?user_id=&limit=` — one row per tool execution.
