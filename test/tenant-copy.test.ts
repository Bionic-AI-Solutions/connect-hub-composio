import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
afterEach(async () => ctx?.close());

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function oauthConnect(c: Ctx, userId: string) {
  const link = (
    await c.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: c.auth,
      payload: { user_id: userId, toolkit: 'mockapp' },
    })
  ).json();
  const u = new URL(link.connect_url);
  const authorize = new URL(
    (await c.app.inject({ method: 'GET', url: u.pathname + u.search })).headers.location as string,
  );
  const code = c.provider!.approve(authorize.searchParams.get('code_challenge')!);
  const cb = await c.app.inject({
    method: 'GET',
    url: `/oauth/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
  });
  expect(cb.statusCode).toBe(200);
}

async function newTenant(c: Ctx, name: string) {
  const r = (
    await c.app.inject({ method: 'POST', url: '/admin/tenants', headers: admin, payload: { name } })
  ).json();
  return { id: r.tenant.id as string, auth: { authorization: `Bearer ${r.api_key}` } };
}

const copy = (c: Ctx, to: string, payload: Record<string, unknown>, headers = admin) =>
  c.app.inject({ method: 'POST', url: `/admin/tenants/${to}/copy-from`, headers, payload });

describe('tenant copy (admin)', () => {
  it('copies OAuth apps and active accounts, re-encrypted for the target, and is idempotent', async () => {
    ctx = await setup({ withProvider: true });
    // Source: a white-label OAuth app, an OAuth account on it, and a secret-text account.
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth-configs',
      headers: ctx.auth,
      payload: { toolkit: 'mockapp', client_id: 'mock-client', client_secret: 'mock-secret' },
    });
    await oauthConnect(ctx, 'me@a.com');
    const secret = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts',
      headers: ctx.auth,
      payload: { user_id: 'me@a.com', toolkit: 'fake', credentials: { secret_text: 'good-key' } },
    });
    expect(secret.statusCode).toBe(201);
    const target = await newTenant(ctx, 'Reliora');

    const dry = await copy(ctx, target.id, { source_tenant_id: ctx.tenant.id, dry_run: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().accounts.map((a: any) => a.result)).toEqual(['would_copy', 'would_copy']);
    expect(dry.json().auth_configs).toEqual([
      { toolkit: 'mockapp', scheme: 'OAUTH2', own_app: true, result: 'would_copy' },
    ]);
    const empty = await ctx.app.inject({
      method: 'GET',
      url: '/v1/connected-accounts',
      headers: target.auth,
    });
    expect(empty.json().items).toHaveLength(0);

    const done = await copy(ctx, target.id, { source_tenant_id: ctx.tenant.id });
    expect(done.statusCode).toBe(200);
    expect(done.json().accounts.map((a: any) => [a.toolkit, a.user_id, a.result])).toEqual([
      ['mockapp', 'me@a.com', 'copied'],
      ['fake', 'me@a.com', 'copied'],
    ]);
    // The report and the account listing never carry secrets.
    expect(done.body).not.toContain('mock-secret');
    expect(done.body).not.toContain('good-key');

    // The copies work in the target: the secret-text tool runs, and the OAuth account points at the copied
    // white-label app, whose secret is re-encrypted under the target tenant's key.
    const run = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/fake.echo/execute',
        headers: target.auth,
        payload: { user_id: 'me@a.com', arguments: { text: 'hi' } },
      })
    ).json();
    expect(run.successful).toBe(true);
    const { rows } = await ctx.services.db.query(
      `SELECT a.credentials_enc, c.client_secret_enc, c.id AS cfg FROM connected_accounts a
         JOIN auth_configs c ON c.id = a.auth_config_id WHERE a.tenant_id = $1 AND a.toolkit = 'mockapp'`,
      [target.id],
    );
    expect(rows).toHaveLength(1);
    expect(ctx.services.vault.decrypt(rows[0].client_secret_enc, target.id)).toBe('mock-secret');
    expect(() => ctx.services.vault.decrypt(rows[0].credentials_enc, ctx.tenant.id)).toThrow();

    // Re-running copies nothing new.
    const again = await copy(ctx, target.id, { source_tenant_id: ctx.tenant.id });
    expect(again.json().accounts.map((a: any) => a.result)).toEqual(['exists', 'exists']);
    expect(again.json().auth_configs.map((a: any) => a.result)).toEqual(['exists']);
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts', headers: target.auth });
    expect(list.json().items).toHaveLength(2);

    // The source is untouched, and the target's audit log names the copy and its source.
    const src = await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts', headers: ctx.auth });
    expect(src.json().items.map((a: any) => a.status)).toEqual(['ACTIVE', 'ACTIVE']);
    const audit = await ctx.services.db.query(
      `SELECT action, tool FROM audit_log WHERE tenant_id = $1 AND action IN ('account.copied','tenant.copy')`,
      [target.id],
    );
    expect(audit.rows.filter((r: any) => r.action === 'account.copied')).toHaveLength(2);
    expect(audit.rows.filter((r: any) => r.action === 'tenant.copy')).toHaveLength(2);
    expect(audit.rows.every((r: any) => r.tool === `from:${ctx.tenant.id}`)).toBe(true);
  });

  it('reports the same thing in a dry run as in a real run when users collide', async () => {
    ctx = await setup();
    for (const user of ['me@a.com', 'me@old.com', 'constructor'])
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/connected-accounts',
        headers: ctx.auth,
        payload: { user_id: user, toolkit: 'fake', credentials: { secret_text: 'good-key' } },
      });
    const target = await newTenant(ctx, 'Reliora');
    // Two source users map to one target user; "constructor" is not an own key of the map.
    const body = { source_tenant_id: ctx.tenant.id, user_map: { 'me@old.com': 'me@a.com' } };
    const dry = (await copy(ctx, target.id, { ...body, dry_run: true })).json();
    const real = (await copy(ctx, target.id, body)).json();
    const results = (r: any) => r.accounts.map((a: any) => [a.user_id, a.result]);
    expect(results(dry)).toEqual([
      ['me@a.com', 'would_copy'],
      ['me@a.com', 'exists'],
      ['constructor', 'would_copy'],
    ]);
    expect(results(real)).toEqual([
      ['me@a.com', 'copied'],
      ['me@a.com', 'exists'],
      ['constructor', 'copied'],
    ]);
  });

  it('filters by toolkit, maps users and skips inactive accounts', async () => {
    ctx = await setup({ withProvider: true });
    for (const [user, key] of [
      ['me@a.com', 'good-key'],
      ['old@a.com', 'good-key'],
    ])
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/connected-accounts',
        headers: ctx.auth,
        payload: { user_id: user, toolkit: 'fake', credentials: { secret_text: key } },
      });
    await ctx.services.db.query(
      `UPDATE connected_accounts SET status = 'EXPIRED' WHERE user_id = 'old@a.com'`,
    );
    await oauthConnect(ctx, 'me@a.com');
    const target = await newTenant(ctx, 'Reliora');
    const r = await copy(ctx, target.id, {
      source_tenant_id: ctx.tenant.id,
      toolkits: ['fake'],
      user_map: { 'me@a.com': 'me@b.com' },
    });
    expect(r.json().accounts).toEqual([
      { toolkit: 'fake', user_id: 'me@b.com', identifier: null, result: 'copied' },
    ]);
    expect(r.json().auth_configs).toEqual([]);
    const run = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/fake.echo/execute',
        headers: target.auth,
        payload: { user_id: 'me@b.com', arguments: { text: 'hi' } },
      })
    ).json();
    expect(run.successful).toBe(true);
  });

  it('needs the admin token and valid tenants', async () => {
    ctx = await setup();
    const target = await newTenant(ctx, 'Reliora');
    expect((await copy(ctx, target.id, { source_tenant_id: ctx.tenant.id }, ctx.auth)).statusCode).toBe(401);
    expect((await copy(ctx, target.id, {})).statusCode).toBe(400);
    expect((await copy(ctx, target.id, { source_tenant_id: target.id })).statusCode).toBe(400);
    expect((await copy(ctx, target.id, { source_tenant_id: 'tn_missing' })).statusCode).toBe(404);
    expect((await copy(ctx, 'tn_missing', { source_tenant_id: ctx.tenant.id })).statusCode).toBe(404);
    for (const bad of [
      { user_map: { a: 1 } },
      { dry_run: 'true' },
      { dry_run: 1 },
      { toolkits: [] },
      { toolkits: [''] },
    ])
      expect((await copy(ctx, target.id, { source_tenant_id: ctx.tenant.id, ...bad })).statusCode).toBe(400);
    expect((await copy(ctx, target.id, { source_tenant_id: { id: 'x' } })).statusCode).toBe(400);
  });
});
