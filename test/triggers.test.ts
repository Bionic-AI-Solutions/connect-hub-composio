import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, fakeTriggerLog, setup } from './helpers.js';
import { signDelivery } from '../src/triggers/service.js';
import { assertPublicWebhookUrl, isPrivateAddress } from '../src/net/url-guard.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
let receiver: FastifyInstance;
let receiverUrl: string;
const received: { headers: Record<string, any>; raw: string; body: any }[] = [];
let failNext = 0;

beforeEach(async () => {
  received.length = 0;
  fakeTriggerLog.length = 0;
  failNext = 0;
  receiver = Fastify();
  receiver.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, b, done) => done(null, b));
  receiver.post('/events', async (req, reply) => {
    if (failNext > 0) {
      failNext--;
      return reply.status(500).send('nope');
    }
    received.push({ headers: req.headers, raw: req.body as string, body: JSON.parse(req.body as string) });
    return { ok: true };
  });
  await receiver.listen({ port: 0, host: '127.0.0.1' });
  receiverUrl = `http://127.0.0.1:${(receiver.server.address() as any).port}/events`;
});

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  await receiver.close();
});

async function connect(c: Ctx, user = 'u1') {
  await c.app.inject({
    method: 'POST',
    url: '/v1/connected-accounts',
    headers: c.auth,
    payload: { user_id: user, toolkit: 'fake', credentials: { secret_text: 'good-key' } },
  });
}

const subscribe = (c: Ctx, payload: Record<string, unknown>) =>
  c.app.inject({
    method: 'POST',
    url: '/v1/trigger-subscriptions',
    headers: c.auth,
    payload: { webhook_url: receiverUrl, ...payload },
  });

describe('triggers', () => {
  it('lists supported triggers and leaves out app-webhook ones', async () => {
    ctx = await setup();
    const items = (
      await ctx.app.inject({ method: 'GET', url: '/v1/triggers?toolkit=fake', headers: ctx.auth })
    ).json().items;
    expect(items.map((t: any) => t.slug).sort()).toEqual(['fake.new_item', 'fake.on_event']);
    const detail = (
      await ctx.app.inject({ method: 'GET', url: '/v1/triggers/fake.new_item', headers: ctx.auth })
    ).json();
    expect(detail.input_schema.required).toEqual(['label']);
  });

  it('polls, keeps the cursor between runs, and delivers signed events', async () => {
    ctx = await setup();
    expect(
      (await subscribe(ctx, { user_id: 'u1', trigger: 'fake.new_item', config: { label: 'x' } })).json().error
        .code,
    ).toBe('connection_required');
    await connect(ctx);
    const res = await subscribe(ctx, { user_id: 'u1', trigger: 'fake.new_item', config: { label: 'inbox' } });
    expect(res.statusCode).toBe(201);
    const { subscription, signing_secret } = res.json();
    expect(signing_secret).toMatch(/^whsec_/);
    expect(subscription).toMatchObject({ strategy: 'POLLING', status: 'ACTIVE', trigger: 'fake.new_item' });
    expect(fakeTriggerLog[0]).toEqual({ event: 'enable', detail: { label: 'inbox' } });

    // Not due yet → nothing happens.
    expect((await ctx.services.triggers.tick()).polled).toBe(0);
    await ctx.services.db.query(`UPDATE trigger_subscriptions SET next_run_at = now() - interval '1 second'`);
    expect(await ctx.services.triggers.tick()).toMatchObject({ polled: 1, delivered: 2 });
    await ctx.services.db.query(`UPDATE trigger_subscriptions SET next_run_at = now() - interval '1 second'`);
    await ctx.services.triggers.tick();

    expect(received.map((r) => r.body.data.n)).toEqual([1, 2, 3, 4]);
    const first = received[0];
    expect(first.body).toMatchObject({
      type: 'trigger.event',
      trigger: 'fake.new_item',
      user_id: 'u1',
      subscription_id: subscription.id,
    });
    expect(first.body.data.secret).toBe('good-key');
    const ts = first.headers['x-hub-timestamp'];
    expect(first.headers['x-hub-signature-256']).toBe(
      `sha256=${signDelivery(signing_secret, ts, first.raw)}`,
    );

    // Delivered payloads are not kept.
    const { rows } = await ctx.services.db.query(`SELECT status, payload_enc FROM trigger_events`);
    expect(rows.every((r: any) => r.status === 'DELIVERED' && r.payload_enc === null)).toBe(true);
    const events = (
      await ctx.app.inject({
        method: 'GET',
        url: `/v1/trigger-subscriptions/${subscription.id}/events`,
        headers: ctx.auth,
      })
    ).json();
    expect(events.items).toHaveLength(4);
    const usage = (await ctx.app.inject({ method: 'GET', url: '/v1/usage', headers: ctx.auth })).json();
    expect(usage.trigger_events).toBe(4);
  });

  it('receives provider webhooks on a secret URL, answers handshakes, and unregisters on delete', async () => {
    ctx = await setup();
    await connect(ctx);
    const { subscription } = (await subscribe(ctx, { user_id: 'u1', trigger: 'fake.on_event' })).json();
    const hookUrl = fakeTriggerLog.find((l) => l.event === 'register')!.detail as string;
    expect(hookUrl).toMatch(new RegExp(`^http://hub.test/hooks/${subscription.id}/[A-Za-z0-9_-]{20,}$`));
    const path = new URL(hookUrl).pathname;

    const hs = await ctx.app.inject({ method: 'GET', url: `${path}?challenge=abc123` });
    expect(hs.json()).toEqual({ challenge: 'abc123' });

    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/hooks/${subscription.id}/wrong-token`,
          payload: { a: 1 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await ctx.app.inject({ method: 'POST', url: `/hooks/trg_nope/x`, payload: { a: 1 } })).statusCode,
    ).toBe(404);

    const ok = await ctx.app.inject({ method: 'POST', url: path, payload: { action: 'opened', id: 7 } });
    expect(ok.json()).toEqual({ received: 1 });
    const ignored = await ctx.app.inject({ method: 'POST', url: path, payload: { ignore: true } });
    expect(ignored.json()).toEqual({ received: 0 });
    const form = await ctx.app.inject({
      method: 'POST',
      url: path,
      payload: 'action=closed&id=8',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.json()).toEqual({ received: 1 });

    await ctx.services.triggers.tick();
    expect(received.map((r) => r.body.data)).toEqual([
      { action: 'opened', id: 7 },
      { action: 'closed', id: '8' },
    ]);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/trigger-subscriptions/${subscription.id}`,
      headers: ctx.auth,
    });
    expect(del.json()).toEqual({ provider_cleanup: 'ok' });
    expect(fakeTriggerLog.at(-1)).toEqual({ event: 'unregister', detail: hookUrl });
    expect((await ctx.app.inject({ method: 'POST', url: path, payload: {} })).statusCode).toBe(404);
  });

  it('retries failed deliveries with backoff', async () => {
    ctx = await setup();
    await connect(ctx);
    const { subscription } = (await subscribe(ctx, { user_id: 'u1', trigger: 'fake.on_event' })).json();
    const path = new URL(fakeTriggerLog.find((l) => l.event === 'register')!.detail as string).pathname;
    failNext = 1;
    await ctx.app.inject({ method: 'POST', url: path, payload: { n: 1 } });
    await ctx.services.triggers.tick();
    let ev = (await ctx.services.db.query(`SELECT * FROM trigger_events`)).rows[0];
    expect(ev).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(ev.last_error).toContain('HTTP 500');
    expect(new Date(ev.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);

    // Not retried before the backoff elapses.
    expect((await ctx.services.triggers.tick()).delivered).toBe(0);
    await ctx.services.db.query(`UPDATE trigger_events SET next_attempt_at = now()`);
    await ctx.services.triggers.tick();
    ev = (await ctx.services.db.query(`SELECT * FROM trigger_events`)).rows[0];
    expect(ev).toMatchObject({ status: 'DELIVERED', attempts: 2 });
    expect(received).toHaveLength(1);
    expect(subscription.status).toBe('ACTIVE');
  });

  it('isolates tenants', async () => {
    ctx = await setup();
    await connect(ctx);
    const { subscription } = (await subscribe(ctx, { user_id: 'u1', trigger: 'fake.on_event' })).json();
    const other = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: 'Other' },
      })
    ).json();
    const h = { authorization: `Bearer ${other.api_key}` };
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/trigger-subscriptions', headers: h })).json().items,
    ).toHaveLength(0);
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/v1/trigger-subscriptions/${subscription.id}`,
          headers: h,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('webhook URL guard', () => {
  it('refuses private, internal and non-https targets in production mode', () => {
    for (const bad of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.1.2.3/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://paperclip.default.svc/hook',
      'https://intranet/hook',
      'https://user:pass@example.com/hook',
    ]) {
      expect(() => assertPublicWebhookUrl(bad, false), bad).toThrow();
    }
    expect(assertPublicWebhookUrl('https://org.baisoln.com/api/hooks/x', false).hostname).toBe(
      'org.baisoln.com',
    );
  });

  it('classifies addresses', () => {
    expect(isPrivateAddress('192.168.0.210')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
});
