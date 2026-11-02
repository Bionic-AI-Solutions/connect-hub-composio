/**
 * Plan limits and metering. Limits are enforced across replicas through the database (one atomic upsert per call);
 * usage rolls up per tenant per calendar month (UTC) for billing exports.
 */
import type { Db } from '../db/index.js';
import { AppError, badRequest } from '../errors.js';

export interface Limits {
  rate_limit_per_minute: number | null;
  monthly_tool_call_limit: number | null;
}

export interface Branding {
  display_name?: string;
  logo_url?: string;
  accent_color?: string;
  support_email?: string;
}

export const currentPeriod = (d = new Date()) => d.toISOString().slice(0, 7);

export class UsageService {
  private cache = new Map<string, { at: number; limits: Limits }>();

  constructor(private readonly db: Db) {}

  async limits(tenantId: string): Promise<Limits> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < 30_000) return hit.limits;
    const row = (
      await this.db.query<Limits>(
        'SELECT rate_limit_per_minute, monthly_tool_call_limit FROM tenants WHERE id = $1',
        [tenantId],
      )
    ).rows[0] ?? { rate_limit_per_minute: null, monthly_tool_call_limit: null };
    this.cache.set(tenantId, { at: Date.now(), limits: row });
    return row;
  }

  async setLimits(tenantId: string, input: Partial<Limits>): Promise<Limits> {
    const v = (x: unknown, name: string) => {
      if (x === undefined) return undefined;
      if (x === null) return null;
      if (!Number.isInteger(x) || (x as number) < 1)
        throw badRequest(`${name} must be a positive integer or null`);
      return x as number;
    };
    const rate = v(input.rate_limit_per_minute, 'rate_limit_per_minute');
    const monthly = v(input.monthly_tool_call_limit, 'monthly_tool_call_limit');
    if (rate !== undefined)
      await this.db.query('UPDATE tenants SET rate_limit_per_minute = $1 WHERE id = $2', [rate, tenantId]);
    if (monthly !== undefined)
      await this.db.query('UPDATE tenants SET monthly_tool_call_limit = $1 WHERE id = $2', [
        monthly,
        tenantId,
      ]);
    this.cache.delete(tenantId);
    return this.limits(tenantId);
  }

  /** Throws 429 when the tenant is over its per-minute rate or monthly quota. Counts the call against the rate. */
  async admit(tenantId: string): Promise<void> {
    const l = await this.limits(tenantId);
    if (l.monthly_tool_call_limit !== null) {
      const used = Number(
        (
          await this.db.query('SELECT tool_calls FROM usage_monthly WHERE tenant_id = $1 AND period = $2', [
            tenantId,
            currentPeriod(),
          ])
        ).rows[0]?.tool_calls ?? 0,
      );
      if (used >= l.monthly_tool_call_limit) {
        throw new AppError(
          429,
          'quota_exceeded',
          `Monthly tool-call quota of ${l.monthly_tool_call_limit} reached`,
          {
            period: currentPeriod(),
          },
        );
      }
    }
    if (l.rate_limit_per_minute !== null) {
      const n = Number(
        (
          await this.db.query(
            `INSERT INTO rate_windows (tenant_id, window_start, n) VALUES ($1, date_trunc('minute', now()), 1)
             ON CONFLICT (tenant_id, window_start) DO UPDATE SET n = rate_windows.n + 1 RETURNING n`,
            [tenantId],
          )
        ).rows[0].n,
      );
      if (Math.random() < 0.02) {
        await this.db.query(`DELETE FROM rate_windows WHERE window_start < now() - interval '10 minutes'`);
      }
      if (n > l.rate_limit_per_minute) {
        throw new AppError(
          429,
          'rate_limited',
          `Rate limit of ${l.rate_limit_per_minute} tool calls per minute exceeded`,
          {
            retry_after_seconds: 60 - new Date().getUTCSeconds(),
          },
        );
      }
    }
  }

  async recordCall(tenantId: string, ok: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO usage_monthly (tenant_id, period, tool_calls, failed_calls) VALUES ($1, $2, 1, $3)
       ON CONFLICT (tenant_id, period) DO UPDATE SET tool_calls = usage_monthly.tool_calls + 1,
         failed_calls = usage_monthly.failed_calls + EXCLUDED.failed_calls`,
      [tenantId, currentPeriod(), ok ? 0 : 1],
    );
  }

  async recordTriggerEvents(tenantId: string, n: number): Promise<void> {
    if (!n) return;
    await this.db.query(
      `INSERT INTO usage_monthly (tenant_id, period, trigger_events) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, period) DO UPDATE SET trigger_events = usage_monthly.trigger_events + EXCLUDED.trigger_events`,
      [tenantId, currentPeriod(), n],
    );
  }

  private checkPeriod(period?: string) {
    const p = period ?? currentPeriod();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw badRequest('period must look like YYYY-MM');
    return p;
  }

  async report(tenantId: string, period?: string) {
    const p = this.checkPeriod(period);
    const row = (
      await this.db.query('SELECT * FROM usage_monthly WHERE tenant_id = $1 AND period = $2', [tenantId, p])
    ).rows[0];
    return {
      period: p,
      tool_calls: Number(row?.tool_calls ?? 0),
      failed_calls: Number(row?.failed_calls ?? 0),
      trigger_events: Number(row?.trigger_events ?? 0),
      limits: await this.limits(tenantId),
    };
  }

  /** Billing export across tenants. */
  async allTenants(period?: string) {
    const p = this.checkPeriod(period);
    const { rows } = await this.db.query(
      `SELECT t.id AS tenant_id, t.name, COALESCE(u.tool_calls, 0) AS tool_calls, COALESCE(u.failed_calls, 0) AS failed_calls,
              COALESCE(u.trigger_events, 0) AS trigger_events, t.monthly_tool_call_limit, t.rate_limit_per_minute
       FROM tenants t LEFT JOIN usage_monthly u ON u.tenant_id = t.id AND u.period = $1 ORDER BY t.name`,
      [p],
    );
    return {
      period: p,
      items: rows.map((r) => ({
        tenant_id: r.tenant_id,
        name: r.name,
        tool_calls: Number(r.tool_calls),
        failed_calls: Number(r.failed_calls),
        trigger_events: Number(r.trigger_events),
        monthly_tool_call_limit: r.monthly_tool_call_limit,
        rate_limit_per_minute: r.rate_limit_per_minute,
      })),
    };
  }

  // ───────────────────────────── branding ─────────────────────────────

  async branding(tenantId: string): Promise<Branding> {
    return (
      (await this.db.query('SELECT branding FROM tenants WHERE id = $1', [tenantId])).rows[0]?.branding ?? {}
    );
  }

  async setBranding(tenantId: string, input: Record<string, unknown>): Promise<Branding> {
    const out: Branding = {};
    const str = (k: keyof Branding, max: number, re?: RegExp, msg?: string) => {
      const v = input[k];
      if (v === undefined || v === null || v === '') return;
      if (typeof v !== 'string' || v.length > max || (re && !re.test(v)))
        throw badRequest(msg ?? `${k} is invalid`);
      out[k] = v;
    };
    str('display_name', 80);
    str('logo_url', 500, /^https:\/\/[^\s"'<>]+$/, 'logo_url must be an https URL');
    str('accent_color', 7, /^#[0-9a-fA-F]{6}$/, 'accent_color must look like #3b5bdb');
    str('support_email', 200, /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'support_email must be an email address');
    await this.db.query('UPDATE tenants SET branding = $1 WHERE id = $2', [JSON.stringify(out), tenantId]);
    return out;
  }
}
