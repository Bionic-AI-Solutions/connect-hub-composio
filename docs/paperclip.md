# Using Connect Hub from Paperclip

Paperclip (org.baisoln.com) is the first consumer. Paperclip already governs remote MCP servers: it catalogs
their tools, classifies risk, quarantines destructive tools, requires approvals and audits every call. Connect
Hub plugs in as one or more **generic remote MCP connections**, so no Paperclip code change is needed.

Paperclip's built-in Composio screens (app list, account picker) are tied to Composio's own hostnames
(`connect.composio.dev`, `dashboard.composio.dev`) and do not apply to the hub. A Paperclip-side "Connect Hub"
aggregator adapter that brings back those screens is on the roadmap.

## How the pieces map

| Paperclip                                | Connect Hub                                                           |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Company (one per client)                 | Tenant (separate accounts, OAuth app configs and audit log)           |
| Application / connection (`remote_http`) | MCP server (`direct` mode, one or a few related toolkits)             |
| Credential policy `per_user`             | One hub MCP token per Paperclip user; `user_id` = the user's email    |
| Credential policy `per_agent`            | One hub MCP token per agent; `user_id` = `agent:<agentId>`            |
| Credential policy `shared`               | One token for the company account; `user_id` = `company:<companyId>`  |
| Tool risk (read / write / destructive)   | MCP annotations on every tool (`readOnlyHint`, `destructiveHint`)     |
| Authorization pending                    | MCP URL elicitation (JSON-RPC `-32042`) carrying the hub connect link |

Use `direct` mode for Paperclip so each tool is a separate catalog entry that Paperclip can review, allow or
block. Avoid `router` mode here: its `hub_execute` tool can run any tool, so Paperclip can only govern it as one
destructive tool.

Create Paperclip-facing servers with `connect_handoff: "elicitation"`. When a user has not connected the app,
the tool call fails with a standard URL elicitation, which Paperclip shows to the responsible person as an
authorization step. Once they connect, the agent retries.

## 1. Deploy

From the Deploy repo (`k8s-infrastructure/deploy`):

```bash
vault/seed-vault.sh                       # first run generates MASTER_KEYS, ADMIN_TOKEN, PG_PASSWORD
tier6-apps/deploy-connect-hub.sh
```

The hub is served at `https://connect.baisoln.com`. `/admin` is blocked at the edge; reach it with a port-forward.

## 2. Create the tenant

```bash
kubectl -n connect-hub port-forward svc/connect-hub 3000:80 &
export HUB_URL=http://localhost:3000
export ADMIN_TOKEN="$(vault kv get -field=ADMIN_TOKEN secret/t6-apps/connect-hub/config)"
node scripts/hubctl.mjs tenant:create "Bionic AI (org.baisoln.com)"
```

Keep the returned `api_key` (`chk_…`) in Vault, for example at `secret/t6-apps/connect-hub/tenants`, field
`baisoln_api_key`. It is shown once.

## 3. OAuth apps

Register one OAuth app per provider family with the redirect URI `https://connect.baisoln.com/oauth/callback`,
then store it as a platform app:

```bash
vault kv patch secret/t6-apps/connect-hub/config \
  OAUTH_GOOGLE_CLIENT_ID=… OAUTH_GOOGLE_CLIENT_SECRET=… \
  OAUTH_GITHUB_CLIENT_ID=… OAUTH_GITHUB_CLIENT_SECRET=…
kubectl -n connect-hub rollout restart deploy/connect-hub
```

A client that wants consent screens under its own brand can instead register its own app and add it to its
tenant with `POST /v1/auth-configs`. API-key apps (Jira, Confluence, Apify, Cloudflare) need no OAuth app.

## 4. Create MCP servers

One server per app keeps Paperclip's catalog and approvals readable:

```bash
export HUB_API_KEY=chk_…
node scripts/hubctl.mjs server:create github github --elicitation
node scripts/hubctl.mjs server:create google-workspace gmail,google-drive,google-calendar,google-sheets,google-docs --elicitation
node scripts/hubctl.mjs server:create atlassian jira-cloud,confluence --elicitation
node scripts/hubctl.mjs server:create slack slack --elicitation
```

## 5. Issue tokens

```bash
node scripts/hubctl.mjs token:issue <server_id> salil.kadam@bionicaisolutions.com   # per_user
node scripts/hubctl.mjs token:issue <server_id> agent:<agentId>                      # per_agent
node scripts/hubctl.mjs token:issue <server_id> company:<companyId>                  # shared
```

Each command prints `{url, token}` once. Revoke with `token:revoke <token_id>`.

## 6. Add the connection in Paperclip

Store the token as a Paperclip company secret (`POST /api/companies/:companyId/secrets`, or the Secrets UI),
then create the connection:

```bash
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "https://org.baisoln.com/api/companies/$COMPANY_ID/tools/connections" \
  -d '{
    "applicationId": "'"$APPLICATION_ID"'",
    "name": "GitHub (Connect Hub)",
    "transport": "remote_http",
    "transportConfig": { "url": "https://connect.baisoln.com/mcp", "headers": [] },
    "credentialRefs": [
      { "name": "Authorization", "secretId": "'"$HUB_TOKEN_SECRET_ID"'", "placement": "header", "key": "Authorization", "prefix": "Bearer " }
    ],
    "credentialPolicy": "shared",
    "enabled": false
  }'
```

For `per_user` connections, each person supplies their own hub token for the connection in Paperclip, in place of
the shared secret. Then, following Paperclip's normal lifecycle:

1. Run `POST /api/tool-connections/:id/health-check`.
2. Run `POST /api/tool-connections/:id/catalog/refresh`. Read tools come in as `read`, write tools as `write`, and
   tools such as `delete_*`, `purge_*` and `custom_api_call` as `destructive`, which are quarantined.
3. Review the quarantined tools and re-enable the ones the company wants.
4. Set `enabled: true`.

## 7. Connect accounts

The first time an agent calls a tool for a person who has not connected the app, Paperclip receives the URL
elicitation and shows the person the hub link. They sign in with OAuth or enter an API key on the hub page, and
the agent retries. The hub refreshes tokens automatically. If the person revokes access at the provider, the
next call asks them to connect again.

## Limits today

- Tokens are issued by an operator. Self-service sign-in (MCP OAuth backed by Keycloak, so each person
  authorizes Paperclip without handling a token) is the next identity step on the roadmap.
- Run one hub replica until token refresh takes a database lock.
