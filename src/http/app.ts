import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { Vault, constantTimeEqual } from '../crypto/vault.js';
import { Registry } from '../catalog/registry.js';
import { TenantService } from '../tenancy/tenants.js';
import { ConnectionService } from '../auth/connections.js';
import { Executor } from '../execute/executor.js';
import { McpService, type McpBinding } from '../mcp/gateway.js';
import { OidcClient } from '../oauth/oidc.js';
import { McpOAuthServer } from '../oauth/server.js';
import { registerOAuthRoutes, registerOAuthTenantApi } from '../oauth/routes.js';
import { TriggerService } from '../triggers/service.js';
import { registerHookEndpoint, registerTriggerApi } from './trigger-routes.js';
import { connectPage, messagePage } from '../connect/pages.js';
import { AppError, badRequest, unauthorized } from '../errors.js';
import type { Toolkit } from '../catalog/types.js';
import { annotationsFor } from '../catalog/annotations.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
  }
}

export interface Services {
  config: Config;
  db: Db;
  vault: Vault;
  registry: Registry;
  tenants: TenantService;
  connections: ConnectionService;
  executor: Executor;
  mcp: McpService;
  triggers: TriggerService;
  oauth: McpOAuthServer;
}

export function createServices(config: Config, db: Db, registry: Registry): Services {
  const vault = new Vault(config.MASTER_KEYS);
  const tenants = new TenantService(db);
  const connections = new ConnectionService(db, vault, registry, config);
  const executor = new Executor(db, registry, connections, config);
  const mcp = new McpService(db, registry, executor, connections, config.PUBLIC_URL);
  const triggers = new TriggerService(db, vault, registry, connections, config);
  const oauth = new McpOAuthServer(db, vault, config, new OidcClient(config));
  return { config, db, vault, registry, tenants, connections, executor, mcp, triggers, oauth };
}

function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const k = req.headers['x-api-key'];
  return typeof k === 'string' ? k : undefined;
}

function toolkitSummary(tk: Toolkit) {
  return {
    slug: tk.slug,
    name: tk.name,
    description: tk.description,
    logo_url: tk.logoUrl,
    categories: tk.categories,
    source: tk.source,
    version: tk.version,
    auth_schemes: tk.authSchemes.map((s) => s.type),
    tool_count: tk.tools.length,
  };
}

function toolkitDetail(tk: Toolkit) {
  return {
    ...toolkitSummary(tk),
    auth_schemes: tk.authSchemes.map((s) => ({
      type: s.type,
      display_name: s.displayName,
      description: s.description,
      fields: s.fields.map((f) => ({
        name: f.name,
        display_name: f.displayName,
        required: f.required,
        secret: f.secret,
        type: f.type,
      })),
      oauth2: s.oauth2
        ? { scopes: s.oauth2.scopes, provider: s.oauth2.provider, pkce: s.oauth2.pkce }
        : undefined,
    })),
    tools: tk.tools.map((t) => ({ slug: t.slug, name: t.displayName, description: t.description })),
  };
}

function withStatus(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function buildApp(
  s: Services,
  opts: { logger?: boolean | object } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: s.config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    },
    bodyLimit: 25 * 1024 * 1024,
  });
  await app.register(formbody);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => bearerToken(req)?.slice(0, 16) ?? req.ip,
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation)
      return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    if (err.statusCode && err.statusCode < 500)
      return reply.status(err.statusCode).send({ error: { code: 'error', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  app.get('/healthz', async () => ({ ok: true, toolkits: s.registry.listToolkits().length }));

  // ───────────────────────────── admin (platform operator) ─────────────────────────────
  app.register(async (admin) => {
    admin.addHook('onRequest', async (req) => {
      const t = bearerToken(req);
      if (!t || !constantTimeEqual(t, s.config.ADMIN_TOKEN)) throw unauthorized();
    });
    admin.post<{ Body: { name?: string } }>('/admin/tenants', async (req, reply) => {
      if (!req.body?.name) throw badRequest('name is required');
      const { tenant, apiKey } = await s.tenants.create(req.body.name);
      return reply.status(201).send({ tenant, api_key: apiKey });
    });
    admin.get('/admin/tenants', async () => ({ items: await s.tenants.list() }));
    admin.put<{ Params: { id: string }; Body: any }>('/admin/tenants/:id/sso', async (req) => {
      if (!(await s.tenants.get(req.params.id))) throw new AppError(404, 'not_found', 'Tenant not found');
      return s.oauth.setSsoPolicy(req.params.id, req.body ?? {});
    });
    admin.post<{ Params: { id: string }; Body: { name?: string } }>(
      '/admin/tenants/:id/api-keys',
      async (req, reply) => {
        if (!(await s.tenants.get(req.params.id))) throw new AppError(404, 'not_found', 'Tenant not found');
        const key = await s.tenants.createApiKey(req.params.id, req.body?.name ?? 'key');
        return reply.status(201).send({ id: key.id, api_key: key.token });
      },
    );
  });

  // ───────────────────────────── tenant API (/v1) ─────────────────────────────
  // Each MCP server's own endpoint: sign in with OAuth (or use its chm_ tokens) at this URL.
  const withUrl = <T extends { id: string }>(row: T) => ({
    ...row,
    url: `${s.config.PUBLIC_URL}/mcp/s/${row.id}`,
  });

  app.register(async (v1) => {
    v1.addHook('onRequest', async (req) => {
      const t = bearerToken(req);
      const tenantId = t ? await s.tenants.authenticate(t) : undefined;
      if (!tenantId) throw unauthorized();
      req.tenantId = tenantId;
    });

    v1.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (req, reply) => {
      if (!(await s.tenants.revokeApiKey(req.tenantId!, req.params.id)))
        throw new AppError(404, 'not_found', 'API key not found');
      return reply.status(204).send();
    });

    // Catalog
    v1.get<{ Querystring: { search?: string; category?: string } }>('/v1/toolkits', async (req) => {
      const q = req.query.search?.toLowerCase();
      const items = s.registry
        .listToolkits()
        .filter((tk) => !q || `${tk.slug} ${tk.name} ${tk.description}`.toLowerCase().includes(q))
        .filter((tk) => !req.query.category || tk.categories.includes(req.query.category))
        .map(toolkitSummary);
      return { items, total: items.length };
    });
    v1.get<{ Params: { slug: string } }>('/v1/toolkits/:slug', async (req) =>
      toolkitDetail(s.connections.toolkit(req.params.slug)),
    );
    v1.get<{ Querystring: { toolkit?: string; search?: string; limit?: string } }>(
      '/v1/tools',
      async (req) => {
        const limit = Math.min(Number(req.query.limit) || 50, 500);
        const items = s.registry
          .searchTools(req.query.search ?? '', {
            toolkits: req.query.toolkit ? req.query.toolkit.split(',') : undefined,
            limit,
          })
          .map((t) => ({
            slug: t.slug,
            toolkit: t.toolkit,
            name: t.displayName,
            description: t.description,
          }));
        return { items };
      },
    );
    v1.get<{ Params: { slug: string } }>('/v1/tools/:slug', async (req) => {
      const t = s.registry.getTool(req.params.slug);
      if (!t) throw new AppError(404, 'not_found', `Tool "${req.params.slug}" not found`);
      return {
        slug: t.slug,
        toolkit: t.toolkit,
        name: t.displayName,
        description: t.description,
        input_schema: t.inputSchema,
        dynamic_inputs: t.dynamicInputs,
        annotations: annotationsFor(t),
      };
    });
    v1.post<{
      Params: { slug: string };
      Body: { user_id: string; connected_account_id?: string; arguments?: Record<string, unknown> };
    }>('/v1/tools/:slug/execute', async (req) =>
      s.executor.execute({
        tenantId: req.tenantId!,
        userId: req.body?.user_id,
        tool: req.params.slug,
        arguments: req.body?.arguments,
        connectedAccountId: req.body?.connected_account_id,
      }),
    );
    v1.post<{
      Params: { slug: string };
      Body: {
        user_id: string;
        input: string;
        connected_account_id?: string;
        arguments?: Record<string, unknown>;
      };
    }>('/v1/tools/:slug/options', async (req) => {
      if (!req.body?.user_id || !req.body?.input) throw badRequest('user_id and input are required');
      return s.executor.listOptions({
        tenantId: req.tenantId!,
        userId: req.body.user_id,
        tool: req.params.slug,
        input: req.body.input,
        arguments: req.body.arguments,
        connectedAccountId: req.body.connected_account_id,
      });
    });

    // Auth configs
    v1.post<{ Body: any }>('/v1/auth-configs', async (req, reply) =>
      reply.status(201).send(await s.connections.createAuthConfig(req.tenantId!, req.body ?? ({} as any))),
    );
    v1.get<{ Querystring: { toolkit?: string } }>('/v1/auth-configs', async (req) => ({
      items: await s.connections.listAuthConfigs(req.tenantId!, req.query.toolkit),
    }));
    v1.delete<{ Params: { id: string } }>('/v1/auth-configs/:id', async (req, reply) => {
      await s.connections.deleteAuthConfig(req.tenantId!, req.params.id);
      return reply.status(204).send();
    });

    // Connected accounts
    v1.post<{ Body: any }>('/v1/connected-accounts/link', async (req, reply) =>
      reply.status(201).send(await s.connections.createConnectLink(req.tenantId!, req.body ?? ({} as any))),
    );
    v1.post<{ Body: any }>('/v1/connected-accounts', async (req, reply) =>
      reply.status(201).send(await s.connections.createAccount(req.tenantId!, req.body ?? ({} as any))),
    );
    v1.get<{ Querystring: { user_id?: string; toolkit?: string; status?: string } }>(
      '/v1/connected-accounts',
      async (req) => ({
        items: await s.connections.listAccounts(req.tenantId!, req.query),
      }),
    );
    v1.get<{ Params: { id: string } }>('/v1/connected-accounts/:id', async (req) =>
      s.connections.getAccount(req.tenantId!, req.params.id),
    );
    v1.post<{ Params: { id: string } }>('/v1/connected-accounts/:id/refresh', async (req) =>
      s.connections.forceRefresh(req.tenantId!, req.params.id),
    );
    v1.delete<{ Params: { id: string } }>('/v1/connected-accounts/:id', async (req, reply) => {
      await s.connections.deleteAccount(req.tenantId!, req.params.id);
      return reply.status(204).send();
    });

    // MCP servers
    v1.post<{ Body: any }>('/v1/mcp-servers', async (req, reply) =>
      reply.status(201).send(withUrl(await s.mcp.createServer(req.tenantId!, req.body ?? ({} as any)))),
    );
    v1.get('/v1/mcp-servers', async (req) => ({
      items: (await s.mcp.listServers(req.tenantId!)).map(withUrl),
    }));
    v1.delete<{ Params: { id: string } }>('/v1/mcp-servers/:id', async (req, reply) => {
      await s.mcp.deleteServer(req.tenantId!, req.params.id);
      return reply.status(204).send();
    });
    v1.post<{ Params: { id: string }; Body: { user_id: string } }>(
      '/v1/mcp-servers/:id/tokens',
      async (req, reply) =>
        reply.status(201).send(await s.mcp.issueToken(req.tenantId!, req.params.id, req.body?.user_id)),
    );
    v1.delete<{ Params: { id: string } }>('/v1/mcp-tokens/:id', async (req, reply) => {
      await s.mcp.revokeToken(req.tenantId!, req.params.id);
      return reply.status(204).send();
    });

    registerTriggerApi(v1, s.triggers);
    registerOAuthTenantApi(v1, s.oauth);

    // Audit
    v1.get<{ Querystring: { user_id?: string; limit?: string } }>('/v1/audit-logs', async (req) => {
      const { rows } = await s.db.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND ($2::text IS NULL OR user_id = $2) ORDER BY id DESC LIMIT $3`,
        [req.tenantId, req.query.user_id ?? null, Math.min(Number(req.query.limit) || 100, 1000)],
      );
      return { items: rows };
    });
  });

  // ───────────────────────────── hosted connect (end users, no API key) ─────────────────────────────
  const html = (reply: FastifyReply, body: string, status = 200) =>
    reply
      .status(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self' https:",
      )
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .send(body);

  // Landing page: people who open the bare domain should see a working service, not a 404.
  app.get('/', async (_req, reply) =>
    html(
      reply,
      messagePage(
        'Connect Hub',
        'This service connects your apps (Google, GitHub, Slack, Jira and more) to the AI agents you work with. ' +
          'You reach it through a connect link from your organization, so there is nothing to do here.',
      ),
    ),
  );

  const finish = (
    reply: FastifyReply,
    redirectUrl: string | null,
    params: Record<string, string>,
    title: string,
    msg: string,
    isError = false,
  ) =>
    redirectUrl
      ? reply.redirect(withStatus(redirectUrl, params))
      : html(reply, messagePage(title, msg, isError), isError ? 400 : 200);

  app.get<{ Params: { id: string }; Querystring: { sig?: string } }>('/connect/:id', async (req, reply) => {
    try {
      const { toolkit, scheme } = await s.connections.openConnectRequest(req.params.id, req.query.sig ?? '');
      if (scheme.type === 'OAUTH2' && !scheme.fields.length) {
        return reply.redirect(await s.connections.authorizeUrl(req.params.id, req.query.sig ?? ''));
      }
      return html(
        reply,
        connectPage(
          toolkit,
          scheme,
          `/connect/${req.params.id}?sig=${encodeURIComponent(req.query.sig ?? '')}`,
        ),
      );
    } catch (e) {
      if (e instanceof AppError)
        return html(reply, messagePage('Cannot connect', e.message, true), e.statusCode);
      throw e;
    }
  });

  app.post<{ Params: { id: string }; Querystring: { sig?: string }; Body: Record<string, unknown> }>(
    '/connect/:id',
    async (req, reply) => {
      const sig = req.query.sig ?? '';
      let ctx;
      try {
        ctx = await s.connections.openConnectRequest(req.params.id, sig);
      } catch (e) {
        if (e instanceof AppError)
          return html(reply, messagePage('Cannot connect', e.message, true), e.statusCode);
        throw e;
      }
      try {
        if (ctx.scheme.type === 'OAUTH2')
          return reply.redirect(await s.connections.authorizeUrl(req.params.id, sig, req.body ?? {}));
        const { redirectUrl, account } = await s.connections.completeForm(req.params.id, sig, req.body ?? {});
        return finish(
          reply,
          redirectUrl,
          { status: 'success', connected_account_id: account.id },
          'Connected',
          `${ctx.toolkit.name} is connected. You can close this window.`,
        );
      } catch (e) {
        if (e instanceof AppError && e.statusCode < 500) {
          return html(
            reply,
            connectPage(
              ctx.toolkit,
              ctx.scheme,
              `/connect/${req.params.id}?sig=${encodeURIComponent(sig)}`,
              e.message,
            ),
            400,
          );
        }
        throw e;
      }
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/oauth/callback',
    async (req, reply) => {
      const q = req.query;
      if (q.error || !q.code) {
        return html(
          reply,
          messagePage(
            'Connection cancelled',
            q.error_description ?? q.error ?? 'The provider returned no authorization code.',
            true,
          ),
          400,
        );
      }
      try {
        const { redirectUrl, account } = await s.connections.completeOAuth(q.state ?? '', q.code);
        return finish(
          reply,
          redirectUrl,
          { status: 'success', connected_account_id: account.id },
          'Connected',
          'Your account is connected. You can close this window.',
        );
      } catch (e) {
        if (e instanceof AppError)
          return html(reply, messagePage('Connection failed', e.message, true), e.statusCode);
        throw e;
      }
    },
  );

  // ───────────────────────────── MCP (streamable HTTP, stateless) ─────────────────────────────
  const serveMcp = async (binding: McpBinding, req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST') {
      return reply
        .status(405)
        .header('allow', 'POST')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    }
    const server = s.mcp.buildServer(binding);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  const unauthorizedMcp = (reply: FastifyReply, wwwAuthenticate: string) =>
    reply
      .status(401)
      .header('www-authenticate', wwwAuthenticate)
      .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });

  // Token-per-user endpoint (chm_ tokens issued by the tenant).
  const mcpHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = bearerToken(req);
    const binding = t ? await s.mcp.authenticate(t) : undefined;
    if (!binding) return unauthorizedMcp(reply, 'Bearer');
    return serveMcp(binding, req, reply);
  };

  // Per-server endpoint: accepts the server's chm_ tokens or OAuth access tokens; advertises OAuth discovery.
  const mcpServerHandler = async (
    req: FastifyRequest<{ Params: { serverId: string } }>,
    reply: FastifyReply,
  ) => {
    const serverId = req.params.serverId;
    const t = bearerToken(req);
    let binding: McpBinding | undefined;
    if (t?.startsWith('chm_')) {
      const b = await s.mcp.authenticate(t);
      binding = b && b.server.id === serverId ? b : undefined;
    } else if (t) {
      const o = await s.oauth.validateAccessToken(t, serverId);
      binding = o ? await s.mcp.bindingFor(o.tenantId, o.userId, o.serverId) : undefined;
    }
    if (!binding) {
      return unauthorizedMcp(
        reply,
        `Bearer realm="connect-hub", resource_metadata="${s.oauth.resourceMetadataUrl(serverId)}"${t ? ', error="invalid_token"' : ''}`,
      );
    }
    return serveMcp(binding, req, reply);
  };
  app.post('/mcp/s/:serverId', mcpServerHandler);
  app.get('/mcp/s/:serverId', mcpServerHandler);
  app.delete('/mcp/s/:serverId', mcpServerHandler);

  await registerOAuthRoutes(app, s);

  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  await registerHookEndpoint(app, s.triggers);

  return app;
}
