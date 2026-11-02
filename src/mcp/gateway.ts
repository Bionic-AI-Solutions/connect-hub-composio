/**
 * MCP gateway. Each MCP server config is a named, tenant-owned selection of toolkits. A per-user MCP token
 * (chm_…) binds a server config to one end user, so every tool call runs with that user's connected accounts.
 *
 * Modes:
 *  - direct: every selected tool is listed as its own MCP tool (best for a handful of toolkits).
 *  - router: three meta tools (search / schema / execute) so an agent can reach thousands of tools without
 *    flooding its context window.
 * Both modes add hub tools for listing connections, creating connect links and fetching dynamic options.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db/index.js';
import { constantTimeEqual, newId, sha256 } from '../crypto/vault.js';
import { mintKey, parseKey } from '../tenancy/tenants.js';
import type { Registry } from '../catalog/registry.js';
import type { ToolDef } from '../catalog/types.js';
import type { Executor } from '../execute/executor.js';
import type { ConnectionService } from '../auth/connections.js';
import { AppError, badRequest, notFound } from '../errors.js';

export interface McpServerRow {
  id: string;
  tenant_id: string;
  name: string;
  toolkits: string[];
  tools: string[] | null;
  mode: 'direct' | 'router';
  created_at: string;
}

export interface McpBinding {
  tenantId: string;
  userId: string;
  server: McpServerRow;
}

/** MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function mcpToolName(slug: string): string {
  const name = slug.replace('.', '__').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.length <= 64) return name;
  return `${name.slice(0, 55)}_${sha256(slug).slice(0, 8)}`;
}

export class McpService {
  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly executor: Executor,
    private readonly connections: ConnectionService,
    private readonly publicUrl: string,
  ) {}

  async createServer(
    tenantId: string,
    input: { name: string; toolkits: string[]; tools?: string[]; mode?: string },
  ): Promise<McpServerRow> {
    if (!input.name) throw badRequest('name is required');
    if (!Array.isArray(input.toolkits) || !input.toolkits.length)
      throw badRequest('toolkits must be a non-empty array');
    for (const t of input.toolkits)
      if (!this.registry.getToolkit(t)) throw badRequest(`Unknown toolkit "${t}"`);
    for (const t of input.tools ?? []) {
      const def = this.registry.getTool(t);
      if (!def) throw badRequest(`Unknown tool "${t}"`);
      if (!input.toolkits.includes(def.toolkit))
        throw badRequest(`Tool "${t}" is not in the selected toolkits`);
    }
    const mode = input.mode ?? 'direct';
    if (!['direct', 'router'].includes(mode)) throw badRequest('mode must be direct or router');
    const { rows } = await this.db.query<McpServerRow>(
      'INSERT INTO mcp_servers (id, tenant_id, name, toolkits, tools, mode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [
        newId('mcp'),
        tenantId,
        input.name,
        JSON.stringify(input.toolkits),
        input.tools ? JSON.stringify(input.tools) : null,
        mode,
      ],
    );
    return rows[0];
  }

  async listServers(tenantId: string): Promise<McpServerRow[]> {
    return (
      await this.db.query<McpServerRow>(
        'SELECT * FROM mcp_servers WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId],
      )
    ).rows;
  }

  async deleteServer(tenantId: string, id: string): Promise<void> {
    const { rows } = await this.db.query(
      'DELETE FROM mcp_servers WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId],
    );
    if (!rows.length) throw notFound('MCP server');
  }

  async issueToken(
    tenantId: string,
    serverId: string,
    userId: string,
  ): Promise<{ id: string; url: string; token: string }> {
    if (!userId) throw badRequest('user_id is required');
    const server = (
      await this.db.query('SELECT id FROM mcp_servers WHERE id = $1 AND tenant_id = $2', [serverId, tenantId])
    ).rows[0];
    if (!server) throw notFound('MCP server');
    const k = mintKey('chm');
    const id = newId('mt');
    await this.db.query(
      'INSERT INTO mcp_tokens (id, tenant_id, server_id, user_id, prefix, hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, tenantId, serverId, userId, k.prefix, k.hash],
    );
    return { id, url: `${this.publicUrl}/mcp`, token: k.token };
  }

  async revokeToken(tenantId: string, tokenId: string): Promise<void> {
    const { rows } = await this.db.query(
      'UPDATE mcp_tokens SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [tokenId, tenantId],
    );
    if (!rows.length) throw notFound('MCP token');
  }

  async authenticate(token: string): Promise<McpBinding | undefined> {
    const parsed = parseKey(token, 'chm');
    if (!parsed) return undefined;
    const row = (
      await this.db.query(
        `SELECT t.tenant_id, t.user_id, t.hash, s.* FROM mcp_tokens t JOIN mcp_servers s ON s.id = t.server_id
         WHERE t.prefix = $1 AND t.revoked_at IS NULL`,
        [parsed.prefix],
      )
    ).rows[0];
    if (!row || !constantTimeEqual(row.hash, sha256(parsed.secret))) return undefined;
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      server: {
        id: row.id,
        tenant_id: row.tenant_id,
        name: row.name,
        toolkits: row.toolkits,
        tools: row.tools,
        mode: row.mode,
        created_at: row.created_at,
      },
    };
  }

  private allowedTools(server: McpServerRow): ToolDef[] {
    const out: ToolDef[] = [];
    for (const slug of server.toolkits) {
      const tk = this.registry.getToolkit(slug);
      if (!tk) continue;
      for (const t of tk.tools) if (!server.tools || server.tools.includes(t.slug)) out.push(t);
    }
    return out;
  }

  private hubTools(server: McpServerRow): Tool[] {
    const toolkitEnum = { type: 'string', enum: server.toolkits } as const;
    const tools: Tool[] = [
      {
        name: 'hub_list_connections',
        description: 'List the apps this user has connected (and which toolkits are available to connect).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'hub_connect',
        description:
          'Create a link the user opens to connect an app account (OAuth or API key). Use when a tool fails with connection_required. Show the URL to the user.',
        inputSchema: { type: 'object', properties: { toolkit: toolkitEnum }, required: ['toolkit'] },
      },
      {
        name: 'hub_list_options',
        description:
          'Get valid values for a dynamic input of a tool (dropdowns such as repository, channel, spreadsheet), or the sub-schema of a dynamic input.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool slug, e.g. github.github_create_issue' },
            input: { type: 'string', description: 'Input name' },
            arguments: {
              type: 'object',
              description: 'Values already chosen for other inputs',
              additionalProperties: true,
            },
          },
          required: ['tool', 'input'],
        },
      },
    ];
    if (server.mode === 'router') {
      tools.push(
        {
          name: 'hub_search_tools',
          description: 'Search available tools by keywords. Returns tool slugs and descriptions.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              toolkit: toolkitEnum,
              limit: { type: 'number', default: 15 },
            },
            required: ['query'],
          },
        },
        {
          name: 'hub_get_tool_schema',
          description: 'Get the full input schema of a tool before calling it.',
          inputSchema: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] },
        },
        {
          name: 'hub_execute',
          description: 'Execute a tool by slug with arguments matching its input schema.',
          inputSchema: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              arguments: { type: 'object', additionalProperties: true },
            },
            required: ['tool'],
          },
        },
      );
    }
    return tools;
  }

  /** Build a fresh low-level MCP server bound to one user (stateless transport: one per request). */
  buildServer(b: McpBinding): Server {
    const server = new Server(
      { name: `connect-hub/${b.server.name}`, version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    const allowed = this.allowedTools(b.server);
    const byMcpName = new Map(allowed.map((t) => [mcpToolName(t.slug), t]));
    const bySlug = new Map(allowed.map((t) => [t.slug, t]));

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.hubTools(b.server);
      if (b.server.mode === 'direct') {
        for (const [name, t] of byMcpName) {
          tools.push({
            name,
            description: `[${t.toolkit}] ${t.displayName}: ${t.description}`.slice(0, 1024),
            inputSchema: t.inputSchema as Tool['inputSchema'],
          });
        }
      }
      return { tools };
    });

    const ok = (data: unknown) => ({
      content: [
        { type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
      ],
    });
    const fail = (message: string, details?: unknown) => ({
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: message, ...(details ? { details } : {}) }, null, 2),
        },
      ],
    });

    const run = async (slug: string, args: Record<string, unknown>) => {
      if (!bySlug.has(slug)) return fail(`Tool "${slug}" is not available on this MCP server`);
      const res = await this.executor.execute({
        tenantId: b.tenantId,
        userId: b.userId,
        tool: slug,
        arguments: args,
      });
      if (res.successful) return ok(res.data ?? { ok: true });
      if (res.error?.code === 'connection_required') {
        const tk = bySlug.get(slug)!.toolkit;
        try {
          const link = await this.connections.createConnectLink(b.tenantId, {
            user_id: b.userId,
            toolkit: tk,
          });
          return fail(
            `${res.error.message}. Ask the user to open this link to connect, then retry: ${link.connect_url}`,
          );
        } catch (e) {
          return fail(`${res.error.message}. ${(e as Error).message}`);
        }
      }
      return fail(res.error?.message ?? 'Tool failed', res.error?.details);
    };

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, any>;
      try {
        switch (name) {
          case 'hub_list_connections': {
            const accounts = await this.connections.listAccounts(b.tenantId, { user_id: b.userId });
            return ok({
              connected: accounts
                .filter((a) => b.server.toolkits.includes(a.toolkit))
                .map((a) => ({ id: a.id, toolkit: a.toolkit, status: a.status, identifier: a.identifier })),
              available_toolkits: b.server.toolkits,
            });
          }
          case 'hub_connect': {
            if (!b.server.toolkits.includes(args.toolkit))
              return fail(`Toolkit "${args.toolkit}" is not on this MCP server`);
            const link = await this.connections.createConnectLink(b.tenantId, {
              user_id: b.userId,
              toolkit: args.toolkit,
            });
            return ok({ connect_url: link.connect_url, expires_at: link.expires_at });
          }
          case 'hub_list_options': {
            if (!bySlug.has(args.tool))
              return fail(`Tool "${args.tool}" is not available on this MCP server`);
            return ok(
              await this.executor.listOptions({
                tenantId: b.tenantId,
                userId: b.userId,
                tool: args.tool,
                input: args.input,
                arguments: args.arguments,
              }),
            );
          }
          case 'hub_search_tools': {
            if (b.server.mode !== 'router') break;
            const toolkits = args.toolkit ? [args.toolkit] : b.server.toolkits;
            const found = this.registry
              .searchTools(String(args.query ?? ''), {
                toolkits,
                limit: Math.min(Number(args.limit) || 15, 50),
              })
              .filter((t) => bySlug.has(t.slug));
            return ok(found.map((t) => ({ tool: t.slug, name: t.displayName, description: t.description })));
          }
          case 'hub_get_tool_schema': {
            if (b.server.mode !== 'router') break;
            const t = bySlug.get(args.tool);
            if (!t) return fail(`Tool "${args.tool}" is not available on this MCP server`);
            return ok({
              tool: t.slug,
              description: t.description,
              input_schema: t.inputSchema,
              dynamic_inputs: t.dynamicInputs,
            });
          }
          case 'hub_execute': {
            if (b.server.mode !== 'router') break;
            return await run(String(args.tool), args.arguments ?? {});
          }
          default: {
            const t = b.server.mode === 'direct' ? byMcpName.get(name) : undefined;
            if (t) return await run(t.slug, args);
          }
        }
        return fail(`Unknown tool "${name}"`);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message, e.details);
        return fail((e as Error).message);
      }
    });
    return server;
  }
}
