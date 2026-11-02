import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createServices } from '../src/http/app.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function oauthConnect(c: Ctx, userId: string, redirect?: string) {
  const link = (
    await c.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: c.auth,
      payload: { user_id: userId, toolkit: 'mockapp', redirect_url: redirect },
    })
  ).json();
  const u = new URL(link.connect_url);
  const start = await c.app.inject({ method: 'GET', url: u.pathname + u.search });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location as string);
  expect(authorize.origin + authorize.pathname).toBe(`${c.provider!.base}/authorize`);
  expect(authorize.searchParams.get('client_id')).toBe('mock-client');
  expect(authorize.searchParams.get('redirect_uri')).toBe('http://hub.test/oauth/callback');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const code = c.provider!.approve(authorize.searchParams.get('code_challenge')!);
  return c.app.inject({
    method: 'GET',
    url: `/oauth/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
  });
}

describe('OAuth2 flow', () => {
  it('runs authorize → callback (PKCE) → token exchange → tool call', async () => {
    ctx = await setup({ withProvider: true });
    const cb = await oauthConnect(ctx, 'u1', 'https://app.example.com/done');
    expect(cb.statusCode).toBe(302);
    const back = new URL(cb.headers.location as string);
    expect(back.origin).toBe('https://app.example.com');
    expect(back.searchParams.get('status')).toBe('success');

    const acct = (
      await ctx.app.inject({
        method: 'GET',
        url: `/v1/connected-accounts/${back.searchParams.get('connected_account_id')}`,
        headers: ctx.auth,
      })
    ).json();
    expect(acct).toMatchObject({
      status: 'ACTIVE',
      toolkit: 'mockapp',
      identifier: 'octo',
      scheme: 'OAUTH2',
    });
    expect(acct.expires_at).toBeTruthy();

    const r = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/mockapp.whoami/execute',
        headers: ctx.auth,
        payload: { user_id: 'u1' },
      })
    ).json();
    expect(r).toMatchObject({ successful: true, data: { login: 'octo', token: 'at_1' } });
  });

  it('rejects forged state and replayed callbacks', async () => {
    ctx = await setup({ withProvider: true });
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/oauth/callback?code=x&state=cr_fake.sig' })).statusCode,
    ).toBe(403);
    const link = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/connected-accounts/link',
        headers: ctx.auth,
        payload: { user_id: 'u1', toolkit: 'mockapp' },
      })
    ).json();
    const u = new URL(link.connect_url);
    const authorize = new URL(
      (await ctx.app.inject({ method: 'GET', url: u.pathname + u.search })).headers.location as string,
    );
    const state = encodeURIComponent(authorize.searchParams.get('state')!);
    const code = ctx.provider!.approve(authorize.searchParams.get('code_challenge')!);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/oauth/callback?code=${code}&state=${state}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/oauth/callback?code=${code}&state=${state}` }))
        .statusCode,
    ).toBe(410);
  });

  it('refreshes expiring tokens before execution, and marks revoked grants EXPIRED', async () => {
    ctx = await setup({ withProvider: true });
    await oauthConnect(ctx, 'u1');
    await ctx.services.db.query(`UPDATE connected_accounts SET expires_at = now() - interval '1 minute'`);
    const r = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/mockapp.whoami/execute',
        headers: ctx.auth,
        payload: { user_id: 'u1' },
      })
    ).json();
    expect(r.data.token).toBe('at_2');
    expect(ctx.provider!.state.lastTokenRequest).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt_1',
    });

    // Simulate the user revoking access at the provider.
    const { rows } = await ctx.services.db.query('SELECT id, credentials_enc FROM connected_accounts');
    const value = ctx.services.vault.decrypt<any>(rows[0].credentials_enc, ctx.tenant.id);
    await ctx.services.db.query(
      `UPDATE connected_accounts SET credentials_enc = $1, expires_at = now() WHERE id = $2`,
      [ctx.services.vault.encrypt({ ...value, refresh_token: 'revoked' }, ctx.tenant.id), rows[0].id],
    );
    const r2 = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/tools/mockapp.whoami/execute',
        headers: ctx.auth,
        payload: { user_id: 'u1' },
      })
    ).json();
    expect(r2.successful).toBe(false);
    expect(r2.error.code).toBe('account_not_active');
    const acct = (
      await ctx.app.inject({ method: 'GET', url: `/v1/connected-accounts/${rows[0].id}`, headers: ctx.auth })
    ).json();
    expect(acct.status).toBe('EXPIRED');
  });

  it('two replicas refreshing the same account at once make exactly one refresh call', async () => {
    ctx = await setup({ withProvider: true });
    await oauthConnect(ctx, 'u1');
    await ctx.services.db.query(`UPDATE connected_accounts SET expires_at = now() - interval '1 minute'`);
    ctx.provider!.state.refreshDelayMs = 300;
    // A second "replica": separate services (own in-process caches) over the same database.
    const replica = createServices(ctx.services.config, ctx.services.db, ctx.services.registry);
    const run = (svc: typeof replica) =>
      svc.executor.execute({ tenantId: ctx!.tenant.id, userId: 'u1', tool: 'mockapp.whoami' });
    const [a, b] = await Promise.all([run(ctx.services), run(replica)]);
    expect(a.successful).toBe(true);
    expect(b.successful).toBe(true);
    expect(ctx.provider!.state.refreshCount).toBe(1);
    expect((a.data as any).token).toBe((b.data as any).token);
    const acct = (
      await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts?user_id=u1', headers: ctx.auth })
    ).json().items[0];
    expect(acct.status).toBe('ACTIVE');
    expect(acct.refresh_lock_until).toBeUndefined();
  });

  it('keeps the account ACTIVE when a lease expires mid-refresh and another replica gets invalid_grant', async () => {
    ctx = await setup({ withProvider: true });
    await oauthConnect(ctx, 'u1');
    await ctx.services.db.query(`UPDATE connected_accounts SET expires_at = now() - interval '1 minute'`);
    // Replica A: lease shorter than its (slow) token request, simulating a stalled refresh that outlives the lease.
    ctx.services.connections.leaseSeconds = 1;
    ctx.provider!.state.refreshDelayMs = 1800;
    const replica = createServices(ctx.services.config, ctx.services.db, ctx.services.registry);
    const run = (svc: typeof replica) =>
      svc.executor.execute({ tenantId: ctx!.tenant.id, userId: 'u1', tool: 'mockapp.whoami' });
    const a = run(ctx.services);
    await new Promise((r) => setTimeout(r, 1300)); // A's lease has expired; B takes over with the same refresh token
    const b = await run(replica);
    const first = await a;
    expect(first.successful).toBe(true);
    expect(b.error?.code ?? 'ok').not.toBe('connection_required');
    const acct = (
      await ctx.app.inject({ method: 'GET', url: '/v1/connected-accounts?user_id=u1', headers: ctx.auth })
    ).json().items[0];
    expect(acct.status).toBe('ACTIVE');
    // The account keeps working afterwards.
    ctx.provider!.state.refreshDelayMs = 0;
    expect((await run(replica)).successful).toBe(true);
  });

  it('aborts a token request that hangs instead of holding the lease forever', async () => {
    ctx = await setup({ withProvider: true });
    await oauthConnect(ctx, 'u1');
    await ctx.services.db.query(`UPDATE connected_accounts SET expires_at = now() - interval '1 minute'`);
    ctx.services.connections.tokenTimeoutMs = 300;
    ctx.provider!.state.refreshDelayMs = 3000;
    const started = Date.now();
    const r = await ctx.services.executor.execute({
      tenantId: ctx.tenant.id,
      userId: 'u1',
      tool: 'mockapp.whoami',
    });
    expect(r.successful).toBe(false);
    expect(Date.now() - started).toBeLessThan(2500);
    const { rows } = await ctx.services.db.query('SELECT status, refresh_lock_until FROM connected_accounts');
    expect(rows[0]).toMatchObject({ status: 'ACTIVE', refresh_lock_until: null });
  });

  it('sends JSON token requests to providers that document them (Atlassian)', async () => {
    ctx = await setup({ withProvider: true, tokenFormat: 'json' });
    const cb = await oauthConnect(ctx, 'u1');
    expect(cb.statusCode).toBe(200);
    expect(ctx.provider!.state.lastTokenContentType).toContain('application/json');
    expect(ctx.provider!.state.lastTokenRequest).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'mock-client',
    });
  });

  it('uses a tenant-supplied OAuth app over the platform app (white-label)', async () => {
    ctx = await setup({ withProvider: true });
    const cfg = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth-configs',
      headers: ctx.auth,
      payload: {
        toolkit: 'mockapp',
        client_id: 'tenant-client',
        client_secret: 'tenant-secret',
        scopes: ['read', 'write'],
      },
    });
    expect(cfg.statusCode).toBe(201);
    expect(cfg.json()).toMatchObject({ use_platform_app: false, has_client_secret: true });
    expect(JSON.stringify(cfg.json())).not.toContain('tenant-secret');
    const link = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/connected-accounts/link',
        headers: ctx.auth,
        payload: { user_id: 'u1', toolkit: 'mockapp' },
      })
    ).json();
    const u = new URL(link.connect_url);
    const authorize = new URL(
      (await ctx.app.inject({ method: 'GET', url: u.pathname + u.search })).headers.location as string,
    );
    expect(authorize.searchParams.get('client_id')).toBe('tenant-client');
    expect(authorize.searchParams.get('scope')).toBe('read write');
  });

  it('upgrades a pre-tenant (v1) OAuth app secret to the tenant-scoped format when it is used', async () => {
    ctx = await setup({ withProvider: true });
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth-configs',
      headers: ctx.auth,
      payload: { toolkit: 'mockapp', client_id: 'mock-client', client_secret: 'mock-secret' },
    });
    // Simulate data written before tenant-scoped encryption existed.
    await ctx.services.db.query('UPDATE auth_configs SET client_secret_enc = $1', [
      ctx.services.vault.encrypt('mock-secret'),
    ]);
    const cb = await oauthConnect(ctx, 'u1');
    expect(cb.statusCode).toBe(200);
    const { rows } = await ctx.services.db.query('SELECT client_secret_enc FROM auth_configs');
    expect(rows[0].client_secret_enc.startsWith('v2.')).toBe(true);
    expect(ctx.services.vault.decrypt(rows[0].client_secret_enc, ctx.tenant.id)).toBe('mock-secret');
  });

  it('explains a missing OAuth app', async () => {
    ctx = await setup();
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: ctx.auth,
      payload: { user_id: 'u1', toolkit: 'google-analytics' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toContain('OAUTH_GOOGLE_CLIENT_ID');
  });
});
