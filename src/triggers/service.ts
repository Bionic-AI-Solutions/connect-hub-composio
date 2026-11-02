/**
 * Triggers: app events delivered to a tenant's webhook.
 *
 * - Polling triggers run on an interval; the piece keeps its own cursor in the subscription's store.
 * - Webhook triggers register a hub URL with the provider on enable; deliveries hit /hooks/:id/:token.
 * - Every resulting event goes into an outbox (encrypted) and is POSTed to the tenant's webhook, signed with a
 *   per-subscription secret, retried with backoff.
 *
 * All background work claims rows with a short lease (atomic UPDATE … RETURNING with SKIP LOCKED), so any number of
 * replicas can run the scheduler without double-polling or double-delivering.
 */
import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { constantTimeEqual, newId, randomToken, sha256, type Vault } from '../crypto/vault.js';
import type { Registry } from '../catalog/registry.js';
import type { ConnectionService } from '../auth/connections.js';
import type { ExecutionContext, TriggerDef, TriggerRuntime, WebhookPayload } from '../catalog/types.js';
import { ToolInputError } from '../catalog/types.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { assertPublicWebhookUrl, assertResolvesPublic } from '../net/url-guard.js';

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  connected_account_id: string | null;
  toolkit: string;
  trigger: string;
  strategy: 'POLLING' | 'WEBHOOK';
  config_enc: string;
  webhook_url: string;
  signing_secret_enc: string;
  hook_token_hash: string;
  hook_token_enc: string;
  status: 'ACTIVE' | 'FAILED';
  poll_interval_seconds: number;
  next_run_at: Date | string | null;
  renew_at: Date | string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow {
  id: string;
  seq: string | number;
  subscription_id: string;
  tenant_id: string;
  status: string;
  attempts: number;
  payload_enc: string | null;
  last_error: string | null;
  created_at: Date | string;
  delivered_at: Date | string | null;
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

export function publicSubscription(r: SubscriptionRow) {
  return {
    id: r.id,
    user_id: r.user_id,
    connected_account_id: r.connected_account_id,
    trigger: `${r.toolkit}.${r.trigger}`,
    toolkit: r.toolkit,
    strategy: r.strategy,
    webhook_url: r.webhook_url,
    status: r.status,
    poll_interval_seconds: r.strategy === 'POLLING' ? r.poll_interval_seconds : undefined,
    next_run_at: iso(r.next_run_at),
    last_run_at: iso(r.last_run_at),
    last_error: r.last_error,
    created_at: iso(r.created_at),
  };
}

const MAX_DELIVERY_ATTEMPTS = 6;
const MAX_POLL_FAILURES = 10;
const RENEW_EVERY_MS = 12 * 3600_000;

/** HMAC over `<timestamp>.<body>`, hex. Receivers recompute it to verify origin and freshness. */
export function signDelivery(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export class TriggerService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly registry: Registry,
    private readonly connections: ConnectionService,
    private readonly config: Config,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
  ) {}

  // ───────────────────────────── catalog ─────────────────────────────

  listTriggers(toolkits?: string[]): TriggerDef[] {
    const out: TriggerDef[] = [];
    for (const tk of this.registry.listToolkits()) {
      if (toolkits && !toolkits.includes(tk.slug)) continue;
      out.push(...(tk.triggers ?? []));
    }
    return out;
  }

  getTrigger(slug: string): TriggerDef {
    const [toolkit, ...rest] = slug.split('.');
    const def = this.registry.getToolkit(toolkit)?.triggers?.find((t) => t.name === rest.join('.'));
    if (!def) throw notFound(`Trigger "${slug}"`);
    return def;
  }

  // ───────────────────────────── subscriptions ─────────────────────────────

  private store(tenantId: string, subscriptionId: string): ExecutionContext['store'] {
    const db = this.db;
    const scope = `trigger:${subscriptionId}`;
    return {
      async get<T>(key: string) {
        const { rows } = await db.query(
          'SELECT value FROM kv_store WHERE tenant_id = $1 AND scope = $2 AND key = $3',
          [tenantId, scope, key],
        );
        return (rows[0]?.value ?? null) as T | null;
      },
      async put<T>(key: string, value: T) {
        await db.query(
          `INSERT INTO kv_store (tenant_id, scope, key, value) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, scope, key) DO UPDATE SET value = EXCLUDED.value`,
          [tenantId, scope, key, JSON.stringify(value ?? null)],
        );
        return value;
      },
      async delete(key: string) {
        await db.query('DELETE FROM kv_store WHERE tenant_id = $1 AND scope = $2 AND key = $3', [
          tenantId,
          scope,
          key,
        ]);
      },
    };
  }

  private hookUrl(id: string, token: string) {
    return `${this.config.PUBLIC_URL}/hooks/${id}/${token}`;
  }

  private async runtime(row: SubscriptionRow): Promise<TriggerRuntime> {
    const cred = await this.connections.credentialFor(
      row.tenant_id,
      row.user_id,
      row.toolkit,
      row.connected_account_id ?? undefined,
    );
    return {
      auth: cred?.value,
      config: this.vault.decrypt<Record<string, unknown>>(row.config_enc, row.tenant_id),
      store: this.store(row.tenant_id, row.id),
      webhookUrl: this.hookUrl(row.id, this.vault.decrypt<string>(row.hook_token_enc, row.tenant_id)),
      tenantId: row.tenant_id,
      publicUrl: this.config.PUBLIC_URL,
    };
  }

  private hooks(toolkit: string) {
    const hooks = this.registry.getToolkit(toolkit)?.triggerHooks;
    if (!hooks) throw badRequest(`Toolkit "${toolkit}" has no triggers`);
    return hooks;
  }

  async create(
    tenantId: string,
    input: {
      user_id: string;
      trigger: string;
      config?: Record<string, unknown>;
      webhook_url: string;
      connected_account_id?: string;
      poll_interval_seconds?: number;
    },
  ) {
    if (!input.user_id) throw badRequest('user_id is required');
    if (!input.trigger) throw badRequest('trigger is required');
    if (!input.webhook_url) throw badRequest('webhook_url is required');
    const def = this.getTrigger(input.trigger);
    assertPublicWebhookUrl(input.webhook_url, this.config.TRIGGER_ALLOW_PRIVATE_WEBHOOKS);
    const interval = Math.max(60, Math.min(Number(input.poll_interval_seconds) || 300, 86_400));
    const cred = await this.connections.credentialFor(
      tenantId,
      input.user_id,
      def.toolkit,
      input.connected_account_id,
    );
    const tk = this.registry.getToolkit(def.toolkit)!;
    if (!cred && !tk.authSchemes.some((s) => s.type === 'NO_AUTH')) {
      throw new AppError(
        409,
        'connection_required',
        `User "${input.user_id}" has no active ${tk.name} connection`,
        {
          toolkit: def.toolkit,
        },
      );
    }
    const id = newId('trg');
    const hookToken = randomToken(24);
    const signingSecret = `whsec_${randomToken(24)}`;
    const { rows } = await this.db.query<SubscriptionRow>(
      `INSERT INTO trigger_subscriptions (id, tenant_id, user_id, connected_account_id, toolkit, trigger, strategy, config_enc,
         webhook_url, signing_secret_enc, hook_token_hash, hook_token_enc, poll_interval_seconds, next_run_at, renew_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id,
        tenantId,
        input.user_id,
        cred?.account.id ?? null,
        def.toolkit,
        def.name,
        def.strategy,
        this.vault.encrypt(input.config ?? {}, tenantId),
        input.webhook_url,
        this.vault.encrypt(signingSecret, tenantId),
        sha256(hookToken),
        this.vault.encrypt(hookToken, tenantId),
        interval,
        def.strategy === 'POLLING' ? new Date(Date.now() + interval * 1000) : null,
        def.renews ? new Date(Date.now() + RENEW_EVERY_MS) : null,
      ],
    );
    const row = rows[0];
    try {
      await this.hooks(def.toolkit).enable(def.name, await this.runtime(row));
    } catch (e) {
      await this.db.query('DELETE FROM trigger_subscriptions WHERE id = $1', [id]);
      await this.db.query('DELETE FROM kv_store WHERE tenant_id = $1 AND scope = $2', [
        tenantId,
        `trigger:${id}`,
      ]);
      if (e instanceof AppError) throw e;
      if (e instanceof ToolInputError) throw badRequest(e.message);
      throw new AppError(
        502,
        'trigger_enable_failed',
        `Could not enable the trigger: ${(e as Error).message}`,
      );
    }
    return { subscription: publicSubscription(row), signing_secret: signingSecret };
  }

  async list(tenantId: string, f: { user_id?: string } = {}) {
    const { rows } = await this.db.query<SubscriptionRow>(
      `SELECT * FROM trigger_subscriptions WHERE tenant_id = $1 AND ($2::text IS NULL OR user_id = $2)
       ORDER BY created_at DESC LIMIT 500`,
      [tenantId, f.user_id ?? null],
    );
    return rows.map(publicSubscription);
  }

  private async row(tenantId: string, id: string): Promise<SubscriptionRow> {
    const r = (
      await this.db.query<SubscriptionRow>(
        'SELECT * FROM trigger_subscriptions WHERE id = $1 AND tenant_id = $2',
        [id, tenantId],
      )
    ).rows[0];
    if (!r) throw notFound('Trigger subscription');
    return r;
  }

  async get(tenantId: string, id: string) {
    return publicSubscription(await this.row(tenantId, id));
  }

  /** Unregister with the provider (best effort: the account may already be gone) and delete. */
  async delete(tenantId: string, id: string): Promise<{ provider_cleanup: 'ok' | 'failed' }> {
    const row = await this.row(tenantId, id);
    let cleanup: 'ok' | 'failed' = 'ok';
    try {
      await this.hooks(row.toolkit).disable(row.trigger, await this.runtime(row));
    } catch (e) {
      cleanup = 'failed';
      this.log('trigger disable failed', { subscription: id, error: (e as Error).message });
    }
    await this.db.query('DELETE FROM trigger_subscriptions WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    await this.db.query('DELETE FROM kv_store WHERE tenant_id = $1 AND scope = $2', [
      tenantId,
      `trigger:${id}`,
    ]);
    return { provider_cleanup: cleanup };
  }

  async events(tenantId: string, id: string, limit = 50) {
    await this.row(tenantId, id);
    const { rows } = await this.db.query<EventRow>(
      `SELECT id, subscription_id, tenant_id, status, attempts, last_error, created_at, delivered_at
       FROM trigger_events WHERE subscription_id = $1 AND tenant_id = $2 ORDER BY seq DESC LIMIT $3`,
      [id, tenantId, Math.min(limit, 500)],
    );
    return rows.map((e) => ({
      id: e.id,
      status: e.status,
      attempts: e.attempts,
      last_error: e.last_error,
      created_at: iso(e.created_at),
      delivered_at: iso(e.delivered_at),
    }));
  }

  private async enqueue(row: SubscriptionRow, items: unknown[]) {
    for (const data of items) {
      await this.db.query(
        'INSERT INTO trigger_events (id, subscription_id, tenant_id, payload_enc) VALUES ($1,$2,$3,$4)',
        [newId('evt'), row.id, row.tenant_id, this.vault.encrypt(data, row.tenant_id)],
      );
    }
  }

  // ───────────────────────────── inbound webhooks ─────────────────────────────

  async handleWebhook(
    id: string,
    token: string,
    payload: WebhookPayload,
  ): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
    const row = (
      await this.db.query<SubscriptionRow>('SELECT * FROM trigger_subscriptions WHERE id = $1', [id])
    ).rows[0];
    // Same answer for unknown id and wrong token: do not reveal which subscriptions exist.
    if (!row || !token || !constantTimeEqual(row.hook_token_hash, sha256(token))) {
      throw new AppError(404, 'not_found', 'Not found');
    }
    if (row.status !== 'ACTIVE') return { status: 410, body: { error: 'subscription is not active' } };
    const hooks = this.hooks(row.toolkit);
    const rt = await this.runtime(row);
    if (hooks.handshake) {
      const hs = await hooks.handshake(row.trigger, rt, payload);
      if (hs) return hs;
    }
    const items = await hooks.run(row.trigger, rt, payload);
    await this.enqueue(row, items);
    await this.db.query(
      `UPDATE trigger_subscriptions SET last_run_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    return { status: 200, body: { received: items.length } };
  }

  // ───────────────────────────── background work ─────────────────────────────

  /** Run due polling subscriptions. Returns how many ran. */
  async pollDue(limit = 20): Promise<number> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `UPDATE trigger_subscriptions SET lease_until = now() + interval '5 minutes'
       WHERE id IN (
         SELECT id FROM trigger_subscriptions
         WHERE status = 'ACTIVE' AND strategy = 'POLLING' AND next_run_at <= now()
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit],
    );
    for (const row of rows) {
      try {
        const items = await this.hooks(row.toolkit).run(row.trigger, await this.runtime(row));
        await this.enqueue(row, items);
        await this.db.query(
          `UPDATE trigger_subscriptions SET lease_until = NULL, last_run_at = now(), last_error = NULL,
             consecutive_failures = 0, next_run_at = now() + make_interval(secs => poll_interval_seconds),
             updated_at = now() WHERE id = $1`,
          [row.id],
        );
      } catch (e) {
        const failures = row.consecutive_failures + 1;
        const status =
          failures >= MAX_POLL_FAILURES || (e as AppError).code === 'account_not_active'
            ? 'FAILED'
            : 'ACTIVE';
        await this.db.query(
          `UPDATE trigger_subscriptions SET lease_until = NULL, last_run_at = now(), last_error = $2,
             consecutive_failures = $3, status = $4,
             next_run_at = now() + make_interval(secs => poll_interval_seconds), updated_at = now() WHERE id = $1`,
          [row.id, (e as Error).message.slice(0, 1000), failures, status],
        );
      }
    }
    return rows.length;
  }

  /** Renew provider-side webhook registrations that expire (e.g. watch channels). */
  async renewDue(limit = 20): Promise<number> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `UPDATE trigger_subscriptions SET renew_at = now() + interval '12 hours'
       WHERE id IN (
         SELECT id FROM trigger_subscriptions WHERE status = 'ACTIVE' AND renew_at IS NOT NULL AND renew_at <= now()
         LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit],
    );
    for (const row of rows) {
      try {
        await this.hooks(row.toolkit).renew?.(row.trigger, await this.runtime(row));
      } catch (e) {
        await this.db.query(
          `UPDATE trigger_subscriptions SET last_error = $2, updated_at = now() WHERE id = $1`,
          [row.id, `renew failed: ${(e as Error).message}`.slice(0, 1000)],
        );
      }
    }
    return rows.length;
  }

  /** Deliver pending events to tenant webhooks. Returns how many were attempted. */
  async deliverPending(limit = 50): Promise<number> {
    const { rows } = await this.db.query<EventRow>(
      `UPDATE trigger_events SET lease_until = now() + interval '2 minutes'
       WHERE id IN (
         SELECT id FROM trigger_events
         WHERE status = 'PENDING' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
         ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit],
    );
    // RETURNING order is unspecified; deliver in the order events were recorded (at-least-once, best-effort order).
    rows.sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const ev of rows) await this.deliver(ev);
    return rows.length;
  }

  private async deliver(ev: EventRow) {
    const sub = (
      await this.db.query<SubscriptionRow>('SELECT * FROM trigger_subscriptions WHERE id = $1', [
        ev.subscription_id,
      ])
    ).rows[0];
    if (!sub || !ev.payload_enc) {
      await this.db.query(
        `UPDATE trigger_events SET status = 'FAILED', last_error = 'subscription gone', lease_until = NULL WHERE id = $1`,
        [ev.id],
      );
      return;
    }
    const body = JSON.stringify({
      id: ev.id,
      type: 'trigger.event',
      subscription_id: sub.id,
      trigger: `${sub.toolkit}.${sub.trigger}`,
      toolkit: sub.toolkit,
      user_id: sub.user_id,
      connected_account_id: sub.connected_account_id,
      created_at: iso(ev.created_at),
      data: this.vault.decrypt(ev.payload_enc, ev.tenant_id),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signDelivery(
      this.vault.decrypt<string>(sub.signing_secret_enc, sub.tenant_id),
      timestamp,
      body,
    );
    try {
      const url = new URL(sub.webhook_url);
      await assertResolvesPublic(url, this.config.TRIGGER_ALLOW_PRIVATE_WEBHOOKS);
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'connect-hub-webhooks/1',
          'x-hub-event-id': ev.id,
          'x-hub-timestamp': timestamp,
          'x-hub-signature-256': `sha256=${signature}`,
        },
        body,
      });
      await res.body?.cancel();
      if (res.status < 200 || res.status >= 300) throw new Error(`receiver answered HTTP ${res.status}`);
      await this.db.query(
        `UPDATE trigger_events SET status = 'DELIVERED', attempts = attempts + 1, delivered_at = now(),
           payload_enc = NULL, last_error = NULL, lease_until = NULL WHERE id = $1`,
        [ev.id],
      );
    } catch (e) {
      const attempts = ev.attempts + 1;
      const failed = attempts >= MAX_DELIVERY_ATTEMPTS;
      // 30s, 1m, 2m, 4m, 8m between attempts.
      const delaySec = 30 * 2 ** (attempts - 1);
      await this.db.query(
        `UPDATE trigger_events SET attempts = $2, status = $3, last_error = $4, lease_until = NULL,
           next_attempt_at = now() + make_interval(secs => $5), payload_enc = CASE WHEN $3 = 'FAILED' THEN NULL ELSE payload_enc END
         WHERE id = $1`,
        [ev.id, attempts, failed ? 'FAILED' : 'PENDING', (e as Error).message.slice(0, 1000), delaySec],
      );
    }
  }

  /** One scheduler pass; safe to run on every replica. */
  async tick(): Promise<{ polled: number; delivered: number; renewed: number }> {
    const polled = await this.pollDue();
    const renewed = await this.renewDue();
    const delivered = await this.deliverPending();
    return { polled, delivered, renewed };
  }
}
