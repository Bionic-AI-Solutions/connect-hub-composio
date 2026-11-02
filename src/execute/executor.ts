import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { ConnectionService } from '../auth/connections.js';
import type { Registry } from '../catalog/registry.js';
import { ToolInputError, type ExecutionContext, type OptionsResult, type Toolkit } from '../catalog/types.js';
import { ProviderError } from '../catalog/native/define.js';
import { AppError, badRequest, notFound } from '../errors.js';
import type { UsageService } from '../tenancy/usage.js';

export interface ExecuteRequest {
  tenantId: string;
  userId: string;
  tool: string;
  arguments?: Record<string, unknown>;
  connectedAccountId?: string;
}

export interface ExecuteResult {
  successful: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  connected_account_id?: string;
  duration_ms: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError(504, 'tool_timeout', `Tool did not finish within ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

/** Errors thrown by pieces carry HTTP details in different shapes; reduce them to something an agent can act on. */
function describeError(e: unknown): { code: string; message: string; details?: unknown } {
  if (e instanceof ToolInputError) return { code: 'invalid_input', message: e.message };
  if (e instanceof AppError) return { code: e.code, message: e.message, details: e.details };
  if (e instanceof ProviderError)
    return { code: 'provider_error', message: e.message, details: { status: e.status, body: e.body } };
  const err = e as any;
  const status = err?.response?.status;
  const body = err?.response?.body ?? err?.response?.data;
  if (status)
    return { code: 'provider_error', message: `Provider returned HTTP ${status}`, details: { status, body } };
  // Network failures from fetch() hide the real reason in `cause` (DNS, refused, TLS…).
  const cause = err?.cause
    ? ` (${err.cause.code ?? ''} ${err.cause.message ?? ''})`.replace(/\s+\)/, ')')
    : '';
  return { code: 'execution_error', message: `${err?.message ?? String(e)}${cause}` };
}

export class Executor {
  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly connections: ConnectionService,
    private readonly config: Config,
    private readonly usage?: UsageService,
  ) {}

  private resolve(slug: string): { toolkit: Toolkit; action: string } {
    const tool = this.registry.getTool(slug);
    if (!tool) throw notFound(`Tool "${slug}"`);
    return { toolkit: this.registry.getToolkit(tool.toolkit)!, action: tool.action };
  }

  private context(tenantId: string, userId: string, accountId?: string): ExecutionContext {
    const scope = accountId ?? `user:${userId}`;
    const db = this.db;
    return {
      tenantId,
      userId,
      connectedAccountId: accountId,
      publicUrl: this.config.PUBLIC_URL,
      store: {
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
      },
    };
  }

  private async credential(toolkit: Toolkit, tenantId: string, userId: string, accountId?: string) {
    const cred = await this.connections.credentialFor(tenantId, userId, toolkit.slug, accountId);
    if (cred) return cred;
    if (toolkit.authSchemes.some((s) => s.type === 'NO_AUTH')) return null;
    throw new AppError(
      409,
      'connection_required',
      `User "${userId}" has no active ${toolkit.name} connection`,
      {
        toolkit: toolkit.slug,
        hint: 'Create a connect link (POST /v1/connected-accounts/link) and send the user to connect_url.',
      },
    );
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const started = Date.now();
    let accountId: string | undefined;
    let toolkitSlug: string | undefined;
    let metered = false;
    try {
      if (!req.userId) throw badRequest('user_id is required');
      const { toolkit, action } = this.resolve(req.tool);
      toolkitSlug = toolkit.slug;
      // Plan limits; calls refused here are not billed.
      await this.usage?.admit(req.tenantId);
      metered = true;
      const cred = await this.credential(toolkit, req.tenantId, req.userId, req.connectedAccountId);
      accountId = cred?.account.id;
      const data = await withTimeout(
        toolkit.execute(
          action,
          req.arguments ?? {},
          cred?.value,
          this.context(req.tenantId, req.userId, accountId),
        ),
        this.config.TOOL_TIMEOUT_MS,
      );
      const result: ExecuteResult = {
        successful: true,
        data,
        connected_account_id: accountId,
        duration_ms: Date.now() - started,
      };
      await this.audit(req, toolkitSlug, accountId, 'success', result.duration_ms);
      await this.usage?.recordCall(req.tenantId, true);
      return result;
    } catch (e) {
      const error = describeError(e);
      const duration = Date.now() - started;
      await this.audit(req, toolkitSlug, accountId, 'error', duration, `${error.code}: ${error.message}`);
      if (metered) await this.usage?.recordCall(req.tenantId, false);
      return { successful: false, error, connected_account_id: accountId, duration_ms: duration };
    }
  }

  async listOptions(req: ExecuteRequest & { input: string }): Promise<OptionsResult> {
    const { toolkit, action } = this.resolve(req.tool);
    if (!toolkit.listOptions) throw badRequest(`Toolkit "${toolkit.slug}" has no runtime options`);
    const cred = await this.credential(toolkit, req.tenantId, req.userId, req.connectedAccountId);
    try {
      return await withTimeout(
        toolkit.listOptions(
          action,
          req.input,
          req.arguments ?? {},
          cred?.value,
          this.context(req.tenantId, req.userId, cred?.account.id),
        ),
        this.config.TOOL_TIMEOUT_MS,
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      const d = describeError(e);
      throw new AppError(d.code === 'invalid_input' ? 400 : 502, d.code, d.message, d.details as any);
    }
  }

  private async audit(
    req: ExecuteRequest,
    toolkit: string | undefined,
    accountId: string | undefined,
    status: string,
    ms: number,
    error?: string,
  ) {
    try {
      await this.db.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, toolkit, tool, connected_account_id, status, duration_ms, error)
         VALUES ($1,$2,'tool.execute',$3,$4,$5,$6,$7,$8)`,
        [
          req.tenantId,
          req.userId ?? null,
          toolkit ?? null,
          req.tool,
          accountId ?? null,
          status,
          ms,
          error?.slice(0, 2000) ?? null,
        ],
      );
    } catch {
      /* auditing must never break execution */
    }
  }
}
