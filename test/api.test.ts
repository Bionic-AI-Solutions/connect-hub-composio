import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function connectFake(c: Ctx, userId: string, key = 'good-key') {
  const link = await c.app.inject({
    method: 'POST',
    url: '/v1/connected-accounts/link',
    headers: c.auth,
    payload: { user_id: userId, toolkit: 'fake' },
  });
  expect(link.statusCode).toBe(201);
  const { connect_url } = link.json();
  const path = new URL(connect_url).pathname + new URL(connect_url).search;
  const page = await c.app.inject({ method: 'GET', url: path });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('type="password"');
  return c.app.inject({
    method: 'POST',
    url: path,
    payload: `secret_text=${key}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

describe('tenant API', () => {
  it('serves a landing page at / instead of a 404', async () => {
    ctx = await setup();
    const r = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Connect Hub');
  });

  it('requires a valid API key and admin token', async () => {
    ctx = await setup();
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/toolkits' })).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/toolkits',
          headers: { authorization: 'Bearer chk_nope_nope' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/admin/tenants', headers: ctx.auth })).statusCode,
    ).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/admin/tenants',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/toolkits', headers: ctx.auth });
    expect(list.json().items.map((t: any) => t.slug)).toContain('fake');
  });

  it('connects via hosted form, validates credentials, and executes a piece action', async () => {
    ctx = await setup();
    const bad = await connectFake(ctx, 'u1', 'wrong');
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('bad key');

    const ok = await connectFake(ctx, 'u1');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('is connected');

    const accounts = (
      await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts?user_id=u1', headers: ctx.auth })
    ).json().items;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].credentials_enc).toBeUndefined();
    expect(JSON.stringify(accounts)).not.toContain('good-key');

    const run = (args: any) =>
      ctx!.app.inject({
        method: 'POST',
        url: '/v1/tools/fake.echo/execute',
        headers: ctx!.auth,
        payload: { user_id: 'u1', arguments: args },
      });
    const r1 = (await run({ text: 'hi' })).json();
    expect(r1.successful).toBe(true);
    expect(r1.data).toEqual({
      secret: 'good-key',
      props: { text: 'hi', times: 2, repo: undefined },
      count: 1,
    });
    expect((await run({ text: 'again', times: '5' })).json().data).toMatchObject({
      props: { times: 5 },
      count: 2,
    });

    const missing = (await run({})).json();
    expect(missing.successful).toBe(false);
    expect(missing.error.code).toBe('invalid_input');

    const opts = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tools/fake.echo/options',
      headers: ctx.auth,
      payload: { user_id: 'u1', input: 'repo' },
    });
    expect(opts.json().options[0].value).toEqual({ owner: 'a', repo: 'b' });

    const logs = (await ctx.app.inject({ method: 'GET', url: '/v1/audit-logs', headers: ctx.auth })).json()
      .items;
    expect(logs.length).toBe(3);
  });

  it('reports connection_required for a user with no account', async () => {
    ctx = await setup();
    const r = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/fake.echo/execute',
        headers: ctx.auth,
        payload: { user_id: 'nobody', arguments: { text: 'x' } },
      })
    ).json();
    expect(r.successful).toBe(false);
    expect(r.error.code).toBe('connection_required');
  });

  it('connect links are single-use and signature-checked', async () => {
    ctx = await setup();
    const link = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/connected-accounts/link',
        headers: ctx.auth,
        payload: { user_id: 'u1', toolkit: 'fake' },
      })
    ).json();
    const u = new URL(link.connect_url);
    expect((await ctx.app.inject({ method: 'GET', url: `${u.pathname}?sig=forged` })).statusCode).toBe(403);
    const path = u.pathname + u.search;
    await ctx.app.inject({
      method: 'POST',
      url: path,
      payload: 'secret_text=good-key',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect((await ctx.app.inject({ method: 'GET', url: path })).statusCode).toBe(410);
  });

  it('refuses redirect URLs outside the allowlist', async () => {
    ctx = await setup();
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: ctx.auth,
      payload: { user_id: 'u1', toolkit: 'fake', redirect_url: 'https://evil.example.net/cb' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('isolates tenants', async () => {
    ctx = await setup();
    await connectFake(ctx, 'u1');
    const other = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: 'Other' },
      })
    ).json();
    const otherAuth = { authorization: `Bearer ${other.api_key}` };
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts', headers: otherAuth })).json()
        .items,
    ).toHaveLength(0);
    const mine = (
      await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts', headers: ctx.auth })
    ).json().items[0];
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/v1/connected-accounts/${mine.id}`, headers: otherAuth }))
        .statusCode,
    ).toBe(404);
    const r = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/fake.echo/execute',
        headers: otherAuth,
        payload: { user_id: 'u1', arguments: { text: 'x' } },
      })
    ).json();
    expect(r.error.code).toBe('connection_required');
  });

  it('imports credentials server-to-server and deletes accounts', async () => {
    ctx = await setup();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts',
      headers: ctx.auth,
      payload: { user_id: 'u2', toolkit: 'fake', credentials: { secret_text: 'good-key' } },
    });
    expect(created.statusCode).toBe(201);
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts',
      headers: ctx.auth,
      payload: { user_id: 'u2', toolkit: 'fake', credentials: { secret_text: 'nope' } },
    });
    expect(rejected.statusCode).toBe(422);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/connected-accounts/${created.json().id}`,
      headers: ctx.auth,
    });
    expect(del.statusCode).toBe(204);
  });
});
