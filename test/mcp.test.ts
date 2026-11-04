import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await ctx?.close();
  ctx = undefined;
  client = undefined;
});

async function mcpClient(c: Ctx, mode: 'direct' | 'router', userId = 'u1', connect_handoff = 'text') {
  const server = (
    await c.app.inject({
      method: 'POST',
      url: '/v1/mcp-servers',
      headers: c.auth,
      payload: { name: 'agents', toolkits: ['fake', 'stackexchange'], mode, connect_handoff },
    })
  ).json();
  const tok = (
    await c.app.inject({
      method: 'POST',
      url: `/v1/mcp-servers/${server.id}/tokens`,
      headers: c.auth,
      payload: { user_id: userId },
    })
  ).json();
  const address = await c.app.listen({ port: 0, host: '127.0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tok.token}` } },
  });
  const cl = new Client({ name: 'test', version: '1.0.0' });
  await cl.connect(transport);
  return { cl, tok, server };
}

async function connectFake(c: Ctx, userId: string) {
  await c.app.inject({
    method: 'POST',
    url: '/v1/connected-accounts',
    headers: c.auth,
    payload: { user_id: userId, toolkit: 'fake', credentials: { secret_text: 'good-key' } },
  });
}

const text = (r: any) => JSON.parse(r.content[0].text);

describe('MCP gateway', () => {
  it('rejects requests without a valid MCP token', async () => {
    ctx = await setup();
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(r.statusCode).toBe(401);
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {},
    });
    expect(r2.statusCode).toBe(401);
  });

  it('direct mode lists every tool and runs them as the bound user', async () => {
    ctx = await setup();
    await connectFake(ctx, 'u1');
    const { cl } = await mcpClient(ctx, 'direct');
    client = cl;
    const { tools } = await cl.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'hub_list_connections',
        'hub_connect',
        'hub_list_options',
        'fake__echo',
        'stackexchange__search_questions',
      ]),
    );
    expect(names).not.toContain('hub_execute');

    const res: any = await cl.callTool({ name: 'fake__echo', arguments: { text: 'from mcp' } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatchObject({ secret: 'good-key', props: { text: 'from mcp' } });

    const conns = text(await cl.callTool({ name: 'hub_list_connections', arguments: {} }));
    expect(conns.connected).toHaveLength(1);
  });

  it('router mode exposes search/schema/execute meta tools', async () => {
    ctx = await setup();
    await connectFake(ctx, 'u1');
    const { cl } = await mcpClient(ctx, 'router');
    client = cl;
    const names = (await cl.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'hub_search_tools',
        'hub_get_tool_schema',
        'hub_read',
        'hub_execute',
        'hub_execute_destructive',
      ]),
    );
    expect(names).not.toContain('fake__echo');

    const hits = text(await cl.callTool({ name: 'hub_search_tools', arguments: { query: 'echo' } }));
    expect(hits[0].tool).toBe('fake.echo');
    const schema = text(await cl.callTool({ name: 'hub_get_tool_schema', arguments: { tool: 'fake.echo' } }));
    expect(schema.input_schema.required).toEqual(['text']);
    const out = text(
      await cl.callTool({
        name: 'hub_execute',
        arguments: { tool: 'fake.echo', arguments: { text: 'routed' } },
      }),
    );
    expect(out.props.text).toBe('routed');
  });

  it('each router tool runs one risk class, and all of them require a string slug', async () => {
    ctx = await setup();
    await connectFake(ctx, 'u1');
    const { cl } = await mcpClient(ctx, 'router');
    client = cl;
    const tools = Object.fromEntries((await cl.listTools()).tools.map((t) => [t.name, t]));
    // Clients (e.g. Paperclip) govern by tool name: hub_read is a read, hub_execute a write, and
    // hub_execute_destructive the only way to run a destructive tool.
    expect(tools['hub_read'].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools['hub_execute'].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools['hub_execute_destructive'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    const call = (name: string, tool: unknown, args: Record<string, unknown> = {}): Promise<any> =>
      cl.callTool({ name, arguments: { tool, arguments: args } });
    const refused = async (name: string, tool: string, msg: string) => {
      const r = await call(name, tool, { text: 'x' });
      expect(r.isError, `${name} ${tool}`).toBe(true);
      expect(r.content[0].text).toContain(msg);
    };
    // fake.peek is read-only only because the piece labels it SEARCH; fake.zap is destructive by label.
    expect(text(await call('hub_read', 'fake.peek'))).toEqual({ peeked: true });
    expect(text(await call('hub_execute', 'fake.echo', { text: 'w' })).props.text).toBe('w');
    expect(text(await call('hub_execute', 'fake.peek'))).toEqual({ peeked: true });
    expect(text(await call('hub_execute_destructive', 'fake.zap'))).toEqual({ zapped: true });
    await refused('hub_read', 'fake.echo', 'can change data');
    await refused('hub_read', 'fake.zap', 'use hub_execute_destructive');
    await refused('hub_execute', 'fake.zap', 'is destructive; use hub_execute_destructive');
    await refused('hub_execute_destructive', 'fake.echo', 'is not destructive; use hub_execute');
    await refused('hub_execute_destructive', 'fake.peek', 'use hub_read');
    for (const name of ['hub_read', 'hub_execute', 'hub_execute_destructive']) {
      await refused(name, 'fake.nope', 'not available');
      // A non-string slug must not run: upstream policies match the slug as a string.
      const bad = await call(name, ['fake.echo'], { text: 'x' });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('must be a tool slug string');
    }
  });

  it('returns a connect link when the user has not connected the app', async () => {
    ctx = await setup();
    const { cl } = await mcpClient(ctx, 'direct', 'new-user');
    client = cl;
    const res: any = await cl.callTool({ name: 'fake__echo', arguments: { text: 'x' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('http://hub.test/connect/');
  });

  it('annotates tools so clients can classify risk', async () => {
    ctx = await setup();
    const { cl } = await mcpClient(ctx, 'direct');
    client = cl;
    const tools = Object.fromEntries((await cl.listTools()).tools.map((t) => [t.name, t]));
    expect(tools['stackexchange__search_questions'].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tools['fake__echo'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Echo',
    });
    expect(tools['hub_list_connections'].annotations?.readOnlyHint).toBe(true);
  });

  it('elicitation handoff returns a standard MCP URL elicitation (-32042) when not connected', async () => {
    ctx = await setup();
    const { cl } = await mcpClient(ctx, 'direct', 'new-user', 'elicitation');
    client = cl;
    const err: any = await cl.callTool({ name: 'fake__echo', arguments: { text: 'x' } }).catch((e) => e);
    expect(err.code).toBe(-32042);
    const [el] = err.data.elicitations;
    expect(el).toMatchObject({ mode: 'url' });
    expect(el.url).toContain('http://hub.test/connect/');
    expect(el.elicitationId).toMatch(/^cr_/);
  });

  it('revoked MCP tokens stop working', async () => {
    ctx = await setup();
    const { cl, tok } = await mcpClient(ctx, 'direct');
    client = cl;
    await ctx.app.inject({ method: 'DELETE', url: `/v1/mcp-tokens/${tok.id}`, headers: ctx.auth });
    await expect(cl.listTools()).rejects.toThrow();
  });
});
