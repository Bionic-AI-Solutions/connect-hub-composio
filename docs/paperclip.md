# Using Connect Hub from Paperclip

Paperclip (org.baisoln.com) is the first consumer. Paperclip already governs remote MCP servers: it catalogs
their tools, classifies risk, quarantines destructive tools, requires approvals and audits every call. Connect
Hub plugs in as one or more **generic remote MCP connections**, so no Paperclip code change is needed.

Paperclip's built-in Composio screens (app list, account picker) are tied to Composio's own hostnames
(`connect.composio.dev`, `dashboard.composio.dev`) and do not apply to the hub. A Paperclip-side "Connect Hub"
aggregator adapter that brings back those screens is on the roadmap.

## How the pieces map

| Paperclip                                | Connect Hub                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Company (one per client)                 | Tenant (separate accounts, OAuth app configs and audit log)            |
| Application / connection (`remote_http`) | MCP server (`direct` mode, one or a few related toolkits)              |
| Credential policy `per_user`             | MCP OAuth: each person signs in with Keycloak; `user_id` = their email |
| Credential policy `per_agent`            | One hub MCP token per agent; `user_id` = `agent:<agentId>`             |
| Credential policy `shared`               | One token for the company account; `user_id` = `company:<companyId>`   |
| Tool risk (read / write / destructive)   | MCP annotations on every tool (`readOnlyHint`, `destructiveHint`)      |
| Authorization pending                    | MCP URL elicitation (JSON-RPC `-32042`) carrying the hub connect link  |

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

One server per app keeps Paperclip's catalog and approvals readable. Use the dashboard (MCP servers page) or:

```bash
export HUB_API_KEY=chk_…
node scripts/hubctl.mjs server:create github github --elicitation
node scripts/hubctl.mjs server:create google-workspace gmail,google-drive,google-calendar,google-sheets,google-docs --elicitation
node scripts/hubctl.mjs server:create atlassian atlassian --elicitation      # Jira + Confluence with Atlassian sign-in
node scripts/hubctl.mjs server:create slack slack --elicitation
```

Each server has its own URL, `https://connect.baisoln.com/mcp/s/<server_id>`. It is shown in the dashboard and
returned as `url` by the API.

## 5. Single sign-on for people

People authorize Paperclip themselves through MCP OAuth, signing in with Keycloak. Configure it once:

1. In Keycloak, create a confidential OpenID Connect client (for example `connect-hub`) with the redirect URI
   `https://connect.baisoln.com/oauth2/callback`.
2. Store the client in Vault and restart the hub:

   ```bash
   vault kv patch secret/t6-apps/connect-hub/config      OIDC_ISSUER=https://<keycloak-host>/realms/<realm> OIDC_CLIENT_ID=connect-hub OIDC_CLIENT_SECRET=…
   kubectl -n connect-hub rollout restart deploy/connect-hub
   ```

3. Allow your people to sign in: in the dashboard, go to **Settings → Who can sign in**, or call
   `PUT /v1/settings/sso {"allowed_domains": ["baisoln.com"]}`. Each client tenant sets its own domains.

## 6. Add the connection in Paperclip

**With OAuth (recommended, `per_user`).** Create a remote MCP connection whose URL is the server URL, without any
stored credential:

```bash
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "https://org.baisoln.com/api/companies/$COMPANY_ID/tools/connections" \
  -d '{
    "applicationId": "'"$APPLICATION_ID"'",
    "name": "GitHub (Connect Hub)",
    "transport": "remote_http",
    "transportConfig": { "url": "https://connect.baisoln.com/mcp/s/<server_id>", "headers": [] },
    "credentialPolicy": "per_user",
    "enabled": false
  }'
```

Paperclip finds the hub's OAuth endpoints from the 401 the server returns: protected-resource metadata, then
authorization-server metadata, then dynamic client registration. When a person connects, they sign in with
Keycloak, see the hub's consent page ("Paperclip wants to use the GitHub tools as you@baisoln.com") and are sent
back to Paperclip. Their identity (email) becomes the hub `user_id`. Access tokens last an hour and refresh
automatically. A tenant admin can revoke any grant from the dashboard.

**With hub tokens (`shared` or `per_agent`).** Issue a token and store it as a Paperclip secret:

```bash
node scripts/hubctl.mjs token:issue <server_id> company:<companyId>     # shared company account
node scripts/hubctl.mjs token:issue <server_id> agent:<agentId>         # per agent
```

Then add `"credentialRefs": [{ "name": "Authorization", "secretId": "…", "placement": "header", "key":
"Authorization", "prefix": "Bearer " }]` to the connection, with the matching `credentialPolicy`.

Then, following Paperclip's normal lifecycle:

1. Run `POST /api/tool-connections/:id/health-check`.
2. Run `POST /api/tool-connections/:id/catalog/refresh`. Read tools come in as `read`, write tools as `write`, and
   tools such as `delete_*`, `purge_*` and `custom_api_call` as `destructive`, which are quarantined.
3. Review the quarantined tools and re-enable the ones the company wants.
4. Set `enabled: true`.

## 7. Connect app accounts

The first time an agent calls a tool for a person who has not connected the app, Paperclip receives the URL
elicitation and shows the person the hub link. They sign in to the app with OAuth, or enter an API key, on the
hub page, branded with the tenant's name and colours. Then the agent retries. The hub refreshes app tokens
automatically. If the person revokes access at the provider, the next call asks them to connect again.

## 8. Events into Paperclip (triggers)

To start agent work from app events (new email, new PR, new Jira issue…), subscribe a trigger with a webhook URL
that Paperclip (or a small relay) receives:

```bash
curl -s -XPOST https://connect.baisoln.com/v1/trigger-subscriptions -H "authorization: Bearer $HUB_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"trigger":"github.trigger_issues","user_id":"salil@baisoln.com","webhook_url":"https://…","config":{"repository":{"owner":"acme","repo":"api"}}}'
```

Verify each delivery: `X-Hub-Signature-256` is `sha256=` + HMAC-SHA256(signing secret,
`<X-Hub-Timestamp>.<raw body>`). The signing secret is returned once at subscription time.

## Limits today

- Paperclip shows hub servers as generic MCP connections. The Composio-style app and account screens come with
  the Connect Hub aggregator change in the Paperclip fork.
- Triggers that need one central app subscription per provider (`APP_WEBHOOK`, e.g. Slack app events) are not
  offered yet. Polling and per-account webhook triggers are.
