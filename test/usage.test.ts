import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function connected() {
  const c = await setup();
  await c.app.inject({
    method: 'POST',
    url: '/v1/connected-accounts',
    headers: c.auth,
    payload: { user_id: 'u1', toolkit: 'fake', credentials: { secret_text: 'good-key' } },
  });
  return c;
}
const call = (c: Ctx) =>
  c.app
    .inject({
      method: 'POST',
      url: '/v1/tools/fake.echo/execute',
      headers: c.auth,
      payload: { user_id: 'u1', arguments: { text: 'x' } },
    })
    .then((r) => r.json());

describe('plan limits and metering', () => {
  it('enforces the per-minute rate limit across calls and does not bill refused calls', async () => {
    ctx = await connected();
    const set = await ctx.app.inject({
      method: 'PUT',
      url: `/admin/tenants/${ctx.tenant.id}/limits`,
      headers: admin,
      payload: { rate_limit_per_minute: 2 },
    });
    expect(set.json()).toMatchObject({ rate_limit_per_minute: 2, monthly_tool_call_limit: null });
    expect((await call(ctx)).successful).toBe(true);
    expect((await call(ctx)).successful).toBe(true);
    const third = await call(ctx);
    expect(third.error.code).toBe('rate_limited');
    expect(third.error.details.retry_after_seconds).toBeGreaterThan(0);
    const usage = (await ctx.app.inject({ method: 'GET', url: '/v1/usage', headers: ctx.auth })).json();
    expect(usage).toMatchObject({ tool_calls: 2, failed_calls: 0, limits: { rate_limit_per_minute: 2 } });
  });

  it('enforces the monthly quota and counts failed calls', async () => {
    ctx = await connected();
    await ctx.app.inject({
      method: 'PUT',
      url: `/admin/tenants/${ctx.tenant.id}/limits`,
      headers: admin,
      payload: { monthly_tool_call_limit: 2 },
    });
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tools/fake.echo/execute',
      headers: ctx.auth,
      payload: { user_id: 'u1', arguments: {} },
    });
    expect(bad.json().error.code).toBe('invalid_input');
    expect((await call(ctx)).successful).toBe(true);
    expect((await call(ctx)).error.code).toBe('quota_exceeded');
    const usage = (await ctx.app.inject({ method: 'GET', url: '/v1/usage', headers: ctx.auth })).json();
    expect(usage).toMatchObject({ tool_calls: 2, failed_calls: 1 });
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: `/admin/tenants/${ctx.tenant.id}/limits`,
          headers: admin,
          payload: { monthly_tool_call_limit: 0 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('exports usage for billing as JSON and formula-safe CSV', async () => {
    ctx = await connected();
    await call(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: admin,
      payload: { name: '=HYPERLINK("x")' },
    });
    const json = (await ctx.app.inject({ method: 'GET', url: '/admin/usage', headers: admin })).json();
    expect(json.items.find((t: any) => t.tenant_id === ctx!.tenant.id).tool_calls).toBe(1);
    const csv = await ctx.app.inject({ method: 'GET', url: '/admin/usage?format=csv', headers: admin });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe(
      'tenant_id,name,tool_calls,failed_calls,trigger_events,monthly_tool_call_limit,rate_limit_per_minute',
    );
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/admin/usage?period=2026-13', headers: admin }))
        .statusCode,
    ).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/usage', headers: ctx.auth })).statusCode).toBe(
      401,
    );
  });
});

describe('branding', () => {
  it('validates branding and applies it to the hosted connect page', async () => {
    ctx = await setup();
    for (const bad of [
      { accent_color: 'red;}body{' },
      { logo_url: 'javascript:alert(1)' },
      { logo_url: 'http://x.example.com/a.png' },
      { support_email: 'nope' },
    ]) {
      expect(
        (
          await ctx.app.inject({
            method: 'PUT',
            url: '/v1/settings/branding',
            headers: ctx.auth,
            payload: bad,
          })
        ).statusCode,
      ).toBe(400);
    }
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/settings/branding',
      headers: ctx.auth,
      payload: {
        display_name: 'Acme <Ops>',
        logo_url: 'https://acme.example.com/logo.png',
        accent_color: '#0a7f3f',
        support_email: 'help@acme.example.com',
      },
    });
    expect(saved.statusCode).toBe(200);
    const link = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/connected-accounts/link',
        headers: ctx.auth,
        payload: { user_id: 'u1', toolkit: 'fake' },
      })
    ).json();
    const u = new URL(link.connect_url);
    const page = (await ctx.app.inject({ method: 'GET', url: u.pathname + u.search })).body;
    expect(page).toContain(':root{--accent:#0a7f3f}');
    expect(page).toContain('https://acme.example.com/logo.png');
    expect(page).toContain('Acme &lt;Ops&gt;');
    expect(page).toContain('mailto:help@acme.example.com');
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/settings/branding', headers: ctx.auth })).json()
        .accent_color,
    ).toBe('#0a7f3f');
  });
});
