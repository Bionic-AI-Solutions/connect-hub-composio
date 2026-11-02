# CLAUDE.md

Connect Hub: multi-tenant integration hub (managed auth, connected accounts, tool execution, MCP gateway).
Read `docs/architecture.md` before changing auth, the vault or the catalog adapter.

## Commands

```bash
npm test          # vitest (PGlite in-memory Postgres; mock OAuth provider)
npm run typecheck
npm run format:fix
npm run catalog:list
```

Node 22 (`.nvmrc`). ESM + TypeScript (`NodeNext`), imports use `.js` suffixes.

## Rules

- Every DB query on tenant data must filter by `tenant_id`.
- Never return or log credentials, client secrets, API keys or MCP tokens. Public shapes go through
  `publicAccount` / `publicAuthConfig`.
- Store secrets only via `Vault.encrypt`; store tokens/keys only as sha256 hashes.
- New integrations: prefer `npm run catalog:add -- <piece>`; write a native toolkit (`src/catalog/native/`) only when
  no piece exists or it is broken. Do not use Activepieces `ee` code, Nango, or Pipedream components (licenses forbid
  offering them as a hosted product).
- Provider quirks (extra authorize params) go in `src/catalog/providers.ts`, not in individual toolkits.
- Add a test for every new endpoint or auth path; OAuth paths are tested against `test/helpers.ts`'s mock provider.
