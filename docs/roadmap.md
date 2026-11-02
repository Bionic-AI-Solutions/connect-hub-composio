# Roadmap

## Why this stack

| Option               | License                                                                       | Fit                                 |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| Composio             | Proprietary SaaS                                                              | The thing being replaced            |
| Nango                | Elastic License 2.0 — may not be offered to third parties as a hosted service | Fine internally, blocks the product |
| Pipedream components | Pipedream Source Available License — no competing commercial use              | Blocks the product                  |
| Activepieces pieces  | MIT (outside `ee/`)                                                           | Used as the action catalog          |

Selling through Paperclip (clients use Paperclip; the hub is a backend component) softens the Nango question,
since ELv2 targets offering Nango itself as a managed service. It stays a grey area because "connect your apps"
is Nango's core function; get Nango's written confirmation or a commercial licence before adopting it. The
Pipedream licence excludes any commercial use, so it stays out.

The credential vault, OAuth broker, connect flow and MCP gateway are our own code, so there is no license
constraint on selling the service.

## Done (v0.1)

- Multi-tenant API keys, auth configs (platform or white-label OAuth apps), connected accounts per end user
- Hosted connect page: OAuth2 with PKCE, API key / basic / custom credential forms, provider validation
- Encrypted credential vault with key rotation; automatic token refresh; `EXPIRED` on revoked grants
- Tool catalog: 23 Activepieces pieces + 3 native toolkits (953 tools), JSON Schema inputs, dynamic options
- Tool execution API with timeouts, error normalization and audit log
- MCP gateway (streamable HTTP): per-user tokens, direct and router modes, connect-link hand-off

## Done (v0.2 — Paperclip)

- MCP risk annotations on every tool (read / write / destructive) for Paperclip's catalog governance
- `connect_handoff: "elicitation"`: standard MCP URL elicitation so Paperclip routes connect links to the right person
- Kubernetes deployment in the Deploy repo (Vault + ESO, shared Postgres, Kong, `/admin` blocked at the edge)
- CI: tests and image publish to `docker4zerocool/connect-hub`; `scripts/hubctl.mjs` operator CLI

## Done (v0.3)

- MCP OAuth: the hub is an OAuth 2.1 authorization server for its MCP endpoints, signing people in with Keycloak,
  with a tenant sign-in policy and consent
- Admin dashboard at `/dashboard`
- Triggers: polling and per-account webhook triggers, signed delivery with retries
- Atlassian OAuth 2.0 (3LO) toolkit for Jira and Confluence
- Multi-replica safety: refresh lease; all background work claims rows with leases
- Per-tenant encryption keys (HKDF + AAD); master keys can be held by Vault Transit
- Per-tenant rate limits, monthly quotas, usage metering and billing export; tenant branding on hosted pages
- Provider verification checklist (`docs/provider-verification.md`)
- Paperclip Connect Hub aggregator (in the Paperclip fork)

## Next

1. **App-webhook triggers** (`APP_WEBHOOK`, e.g. Slack Events API): one central app subscription per provider, fanned
   out to tenants.
2. **SDKs** (TypeScript, Python) and an OpenAPI spec; framework adapters (OpenAI/Anthropic tool formats,
   LangChain).
3. **Custom domains** for the connect page per tenant (needs per-domain TLS and ingress).
4. **Dashboard sign-in through SSO** (today: tenant API key); roles for read-only operators.
5. **Piece update pipeline**: pin piece versions, run contract tests, then roll forward.
6. **Data residency and audit export** for regulated clients.
