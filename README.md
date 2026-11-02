# Connect Hub

A self-hosted, multi-tenant integration hub: one place for your users to connect their apps (OAuth or API keys),
and one API — REST or MCP — for your agents to act in those apps on their behalf. It covers the same ground as
Composio's toolkits, auth configs, connected accounts, hosted connect and MCP servers, built on permissively
licensed parts so it can be run internally now and sold as a product later.

Out of the box: **26 toolkits, 953 tools** — GitHub, Gmail, Google Drive/Sheets/Docs/Slides/Forms/Calendar/
Contacts/Tasks/Search Console/My Business, YouTube, Google Analytics, Jira, Confluence, Slack, LinkedIn, Facebook
Pages, Instagram Business, Reddit, Stack Overflow / Stack Exchange, Apify, Todoist, Zoom, Cloudflare.
About 750 more apps are one command away (`npm run catalog:add -- hubspot notion …`).

## How it maps to Composio

| Composio                                     | Connect Hub                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| Toolkits & tools                             | `GET /v1/toolkits`, `GET /v1/tools` — Activepieces pieces + native toolkits   |
| Auth configs (managed or your own OAuth app) | `POST /v1/auth-configs`; platform apps via `OAUTH_<PROVIDER>_*` env           |
| Connected accounts per `user_id`             | `/v1/connected-accounts` — encrypted at rest, auto token refresh              |
| Connect link / hosted auth page              | `POST /v1/connected-accounts/link` → `connect_url`                            |
| Execute a tool                               | `POST /v1/tools/{slug}/execute`                                               |
| MCP servers / Tool Router                    | `POST /v1/mcp-servers` (`direct` or `router` mode) + per-user tokens → `/mcp` |
| Triggers                                     | Not yet — see [docs/roadmap.md](docs/roadmap.md)                              |

## Quick start

```bash
npm install
cp .env.example .env   # then fill MASTER_KEYS and ADMIN_TOKEN (generation commands are in the file)
npm run dev
```

Create a tenant (returns its API key once):

```bash
curl -s -XPOST localhost:3000/admin/tenants -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Bionic AI"}'
```

Connect a user's account and run a tool:

```bash
# 1. Get a link and send the user to connect_url
curl -s -XPOST localhost:3000/v1/connected-accounts/link -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' -d '{"user_id":"salil","toolkit":"github"}'

# 2. Run a tool as that user
curl -s -XPOST localhost:3000/v1/tools/github.github_create_issue/execute -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"user_id":"salil","arguments":{"repository":{"owner":"Bionic-AI-Solutions","repo":"demo"},"title":"Hello"}}'
```

Inputs marked dynamic (like `repository` above) take provider-specific values; list them with
`POST /v1/tools/{slug}/options` `{"user_id": "...", "input": "repository"}`.

Give an agent an MCP endpoint:

```bash
curl -s -XPOST localhost:3000/v1/mcp-servers -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"name":"assistant","toolkits":["github","gmail","slack","jira-cloud"],"mode":"router"}'
curl -s -XPOST localhost:3000/v1/mcp-servers/$SERVER_ID/tokens -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' -d '{"user_id":"salil"}'
```

Then add it to Claude Code (or any MCP client):

```bash
claude mcp add --transport http connect-hub http://localhost:3000/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

When the agent calls a tool for an app the user has not connected, the result contains a connect link to show them.

## OAuth apps

OAuth toolkits need an OAuth app per provider. Either set a platform-wide app (`OAUTH_GOOGLE_CLIENT_ID` /
`OAUTH_GOOGLE_CLIENT_SECRET`, one per provider family), or let a tenant bring its own white-label app with
`POST /v1/auth-configs {"toolkit":"gmail","client_id":"…","client_secret":"…"}`. Register
`$PUBLIC_URL/oauth/callback` as the redirect URI. Per-provider setup notes: [docs/integrations.md](docs/integrations.md).

## Commands

```bash
npm test               # vitest: vault, catalog, API, OAuth (mock provider), MCP
npm run typecheck
npm run catalog:list   # what is loaded (add -- --tools for every tool)
npm run catalog:add -- hubspot notion   # add Activepieces integrations (or -- --all)
npm run build && npm start
docker compose up --build   # Postgres + hub
```

## Docs

- [docs/architecture.md](docs/architecture.md) — components, data model, security model
- [docs/integrations.md](docs/integrations.md) — requested apps, auth type, provider setup notes
- [docs/roadmap.md](docs/roadmap.md) — what is missing for Composio parity and for selling it as a product
- [docs/api.md](docs/api.md) — endpoint reference
- [docs/paperclip.md](docs/paperclip.md) — wiring the hub into Paperclip (org.baisoln.com), deployment included
