import type { FastifyInstance } from 'fastify';
import type { TriggerService } from '../triggers/service.js';
import { AppError } from '../errors.js';

/** Tenant API for triggers. Registered inside the authenticated /v1 scope (req.tenantId is set). */
export function registerTriggerApi(v1: FastifyInstance, triggers: TriggerService) {
  v1.get<{ Querystring: { toolkit?: string } }>('/v1/triggers', async (req) => ({
    items: triggers.listTriggers(req.query.toolkit ? req.query.toolkit.split(',') : undefined).map((t) => ({
      slug: t.slug,
      toolkit: t.toolkit,
      name: t.displayName,
      description: t.description,
      strategy: t.strategy,
    })),
  }));
  v1.get<{ Params: { slug: string } }>('/v1/triggers/:slug', async (req) => {
    const t = triggers.getTrigger(req.params.slug);
    return {
      slug: t.slug,
      toolkit: t.toolkit,
      name: t.displayName,
      description: t.description,
      strategy: t.strategy,
      input_schema: t.inputSchema,
      sample_data: t.sampleData,
    };
  });
  v1.post<{ Body: any }>('/v1/trigger-subscriptions', async (req, reply) =>
    reply.status(201).send(await triggers.create(req.tenantId!, req.body ?? ({} as any))),
  );
  v1.get<{ Querystring: { user_id?: string } }>('/v1/trigger-subscriptions', async (req) => ({
    items: await triggers.list(req.tenantId!, req.query),
  }));
  v1.get<{ Params: { id: string } }>('/v1/trigger-subscriptions/:id', async (req) =>
    triggers.get(req.tenantId!, req.params.id),
  );
  v1.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/v1/trigger-subscriptions/:id/events',
    async (req) => ({
      items: await triggers.events(req.tenantId!, req.params.id, Number(req.query.limit) || 50),
    }),
  );
  v1.delete<{ Params: { id: string } }>('/v1/trigger-subscriptions/:id', async (req) =>
    triggers.delete(req.tenantId!, req.params.id),
  );
}

/** Public endpoint providers call. Keeps the raw body, which some providers sign. */
export async function registerHookEndpoint(app: FastifyInstance, triggers: TriggerService) {
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (req, raw, done) => {
      const text = String(raw ?? '');
      const type = String(req.headers['content-type'] ?? '');
      let body: unknown = text;
      try {
        if (type.includes('json') && text) body = JSON.parse(text);
        else if (type.includes('application/x-www-form-urlencoded'))
          body = Object.fromEntries(new URLSearchParams(text));
      } catch {
        /* keep raw text; the trigger decides */
      }
      done(null, { body, rawBody: text });
    });
    const handler = async (req: any, reply: any) => {
      const parsed = (req.body as { body?: unknown; rawBody?: string } | undefined) ?? {};
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
      try {
        const res = await triggers.handleWebhook(req.params.id, req.params.token, {
          body: parsed.body ?? {},
          rawBody: parsed.rawBody,
          headers,
          queryParams: Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])),
        });
        if (res.headers) reply.headers(res.headers);
        return reply.status(res.status).send(res.body ?? '');
      } catch (e) {
        if (e instanceof AppError)
          return reply.status(e.statusCode).send({ error: { code: e.code, message: e.message } });
        req.log.error(e);
        return reply.status(500).send({ error: { code: 'internal', message: 'Trigger failed' } });
      }
    };
    hooks.post('/hooks/:id/:token', handler);
    hooks.get('/hooks/:id/:token', handler);
  });
}
