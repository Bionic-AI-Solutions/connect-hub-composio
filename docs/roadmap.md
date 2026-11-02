# Roadmap

## Why this stack

| Option               | License                                                                       | Fit                                 |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| Composio             | Proprietary SaaS                                                              | The thing being replaced            |
| Nango                | Elastic License 2.0 — may not be offered to third parties as a hosted service | Fine internally, blocks the product |
| Pipedream components | Pipedream Source Available License — no competing commercial use              | Blocks the product                  |
| Activepieces pieces  | MIT (outside `ee/`)                                                           | Used as the action catalog          |

The credential vault, OAuth broker, connect flow and MCP gateway are our own code, so there is no license
constraint on selling the service.

## Done (v0.1)

- Multi-tenant API keys, auth configs (platform or white-label OAuth apps), connected accounts per end user
- Hosted connect page: OAuth2 with PKCE, API key / basic / custom credential forms, provider validation
- Encrypted credential vault with key rotation; automatic token refresh; `EXPIRED` on revoked grants
- Tool catalog: 23 Activepieces pieces + 3 native toolkits (953 tools), JSON Schema inputs, dynamic options
- Tool execution API with timeouts, error normalization and audit log
- MCP gateway (streamable HTTP): per-user tokens, direct and router modes, connect-link hand-off

## Next — internal use

1. **Triggers**: run piece triggers (webhook + polling strategies) and deliver events to tenant webhooks, signed.
2. **Admin dashboard**: toolkits, auth configs, connected accounts, MCP servers, audit log (Composio's dashboard).
3. **Atlassian OAuth 2.0 (3LO)** native auth for Jira/Confluence so users connect without API tokens.
4. **Multi-replica safety**: row lock around token refresh; move kv_store and audit writes to a queue.
5. **Outbound proxy support** for `fetch`-based native tools (`NODE_USE_ENV_PROXY=1` works on Node 22.21+).

## Next — product

1. **KMS-backed vault** (AWS KMS / GCP KMS / HashiCorp Vault transit) with per-tenant data keys.
2. **Per-tenant quotas and rate limits**, usage metering per tool call, billing export.
3. **SDKs** (TypeScript, Python) and OpenAPI spec; framework adapters (OpenAI/Anthropic tool formats, LangChain).
4. **White-label connect page**: tenant logo, colours, custom domain.
5. **Provider verification**: Google restricted-scope verification, Meta App Review, LinkedIn partner products for
   the platform-managed apps.
6. **Tenant roles** (admin vs. read-only keys), SSO for the dashboard, audit export, data residency options.
7. **Piece update pipeline**: pin piece versions, run contract tests, then roll forward.
