import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../http/app.js';
import { consentPage, messagePage } from '../connect/pages.js';
import { AppError } from '../errors.js';
import { OAuthError } from './server.js';

const securePage = (reply: FastifyReply, body: string, status = 200) =>
  reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    // form-action covers the post-consent redirect to the client, which may be a loopback URL for CLI clients.
    .header(
      'content-security-policy',
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    )
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store')
    .send(body);

const oauthJson = (reply: FastifyReply, e: unknown) => {
  if (e instanceof OAuthError) {
    return reply
      .status(e.status)
      .header('cache-control', 'no-store')
      .send({ error: e.error, error_description: e.description });
  }
  throw e;
};

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Public OAuth endpoints (discovery, registration, authorize, token). */
export async function registerOAuthRoutes(app: FastifyInstance, s: Services) {
  // Browser binding for the authorization flow. __Host- (Secure, path=/, no Domain) whenever the hub is on https.
  const secure = s.config.PUBLIC_URL.startsWith('https://');
  const cookieName = secure ? '__Host-chub_oauth' : 'chub_oauth';
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const browserNonce = (req: { headers: { cookie?: string } }) => readCookie(req.headers.cookie, cookieName);
  app.get<{ Params: { serverId: string } }>(
    '/.well-known/oauth-protected-resource/mcp/s/:serverId',
    async (req, reply) => {
      const server = await s.mcp.getServer(req.params.serverId);
      if (!server) return reply.status(404).send({ error: 'not_found' });
      return s.oauth.protectedResourceMetadata(server.id, server.name);
    },
  );
  app.get('/.well-known/oauth-authorization-server', async () => s.oauth.authorizationServerMetadata());

  app.post<{ Body: Record<string, any> }>('/oauth2/register', async (req, reply) => {
    try {
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send(await s.oauth.register(req.body ?? {}));
    } catch (e) {
      return oauthJson(reply, e);
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/oauth2/authorize', async (req, reply) => {
    try {
      const next = await s.oauth.authorize(req.query, async (id) => {
        const server = await s.mcp.getServer(id);
        return server ? { tenantId: server.tenant_id } : undefined;
      });
      if (next.browserNonce) {
        reply.header('set-cookie', `${cookieName}=${next.browserNonce}; Max-Age=600; ${cookieAttrs}`);
      }
      return reply.redirect(next.location);
    } catch (e) {
      if (e instanceof AppError)
        return securePage(reply, messagePage('Cannot authorize', e.message, true), e.statusCode);
      throw e;
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/oauth2/callback',
    async (req, reply) => {
      if (req.query.error || !req.query.code) {
        return securePage(
          reply,
          messagePage('Sign-in cancelled', req.query.error_description ?? req.query.error ?? 'No code', true),
          400,
        );
      }
      try {
        const r = await s.oauth.completeSignIn(req.query.state ?? '', req.query.code, browserNonce(req));
        const server = await s.mcp.getServer(r.serverId);
        return securePage(
          reply,
          consentPage(
            {
              clientName: r.clientName,
              redirectHost: r.redirectHost,
              email: r.email,
              serverName: server?.name ?? 'Connect Hub',
              requestId: r.requestId,
              consentToken: r.consentToken,
            },
            await s.usage.branding(r.tenantId),
          ),
        );
      } catch (e) {
        if (e instanceof AppError)
          return securePage(reply, messagePage('Cannot authorize', e.message, true), e.statusCode);
        throw e;
      }
    },
  );

  app.post<{ Body: { request_id?: string; consent_token?: string; decision?: string } }>(
    '/oauth2/consent',
    async (req, reply) => {
      try {
        const b = req.body ?? {};
        const next = await s.oauth.decide(
          b.request_id ?? '',
          b.consent_token ?? '',
          b.decision === 'allow',
          browserNonce(req),
        );
        reply.header('set-cookie', `${cookieName}=; Max-Age=0; ${cookieAttrs}`);
        return reply.redirect(next);
      } catch (e) {
        if (e instanceof AppError)
          return securePage(reply, messagePage('Cannot authorize', e.message, true), e.statusCode);
        throw e;
      }
    },
  );

  app.post<{ Body: Record<string, any> }>('/oauth2/token', async (req, reply) => {
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(await s.oauth.token(req.body ?? {}, req.headers.authorization));
    } catch (e) {
      return oauthJson(reply, e);
    }
  });

  app.post<{ Body: Record<string, any> }>('/oauth2/revoke', async (req, reply) => {
    try {
      await s.oauth.revoke(req.body ?? {}, req.headers.authorization);
      return reply.status(200).send({});
    } catch (e) {
      return oauthJson(reply, e);
    }
  });
}

/** Tenant API: who may sign in, and the OAuth grants people have given. */
export function registerOAuthTenantApi(v1: FastifyInstance, oauth: Services['oauth']) {
  v1.get('/v1/settings/sso', async (req) => oauth.getSsoPolicy(req.tenantId!));
  v1.put<{ Body: any }>('/v1/settings/sso', async (req) => oauth.setSsoPolicy(req.tenantId!, req.body ?? {}));
  v1.get<{ Querystring: { user_id?: string } }>('/v1/mcp-oauth-grants', async (req) => ({
    items: await oauth.listGrants(req.tenantId!, req.query.user_id),
  }));
  v1.delete<{ Params: { id: string } }>('/v1/mcp-oauth-grants/:id', async (req, reply) => {
    await oauth.revokeGrant(req.tenantId!, req.params.id);
    return reply.status(204).send();
  });
}
