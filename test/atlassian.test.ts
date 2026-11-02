import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atlassian, toAdf } from '../src/catalog/native/atlassian.js';
import type { ConnectionValue, ExecutionContext } from '../src/catalog/types.js';

/** A fake api.atlassian.com gateway: two sites, Jira and Confluence endpoints. */
let api: FastifyInstance;
const seen: { method: string; url: string; body: any }[] = [];
const auth = { type: 'OAUTH2', access_token: 'tok' } as ConnectionValue;
const ctx = {} as ExecutionContext;
const run = (action: string, args: Record<string, unknown>) => atlassian.execute(action, args, auth, ctx);

beforeAll(async () => {
  api = Fastify();
  api.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer tok') return reply.status(401).send({ message: 'bad token' });
  });
  api.addHook('preHandler', async (req) => {
    seen.push({ method: req.method, url: req.url, body: req.body });
  });
  api.get('/oauth/token/accessible-resources', async () => [
    { id: 'cloud-a', name: 'acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
    { id: 'cloud-b', name: 'beta', url: 'https://beta.atlassian.net', scopes: ['read:jira-work'] },
  ]);
  api.get('/me', async () => ({ email: 'dev@acme.test' }));
  api.get('/ex/jira/:cloud/rest/api/3/search/jql', async (req: any) => ({
    cloud: req.params.cloud,
    query: req.query,
  }));
  api.post('/ex/jira/:cloud/rest/api/3/issue', async (req: any) => ({ key: 'ENG-1', sent: req.body }));
  api.post('/ex/jira/:cloud/rest/api/3/issue/:key/transitions', async (_req, reply) =>
    reply.status(204).send(),
  );
  api.get('/ex/confluence/:cloud/wiki/api/v2/pages/:id', async () => ({
    id: '42',
    title: 'Old title',
    version: { number: 7 },
    body: { storage: { value: '<p>old</p>' } },
  }));
  api.put('/ex/confluence/:cloud/wiki/api/v2/pages/:id', async (req: any) => ({ updated: req.body }));
  await api.listen({ port: 0, host: '127.0.0.1' });
  process.env.ATLASSIAN_API_BASE = `http://127.0.0.1:${(api.server.address() as any).port}`;
});

afterAll(async () => {
  delete process.env.ATLASSIAN_API_BASE;
  await api.close();
});

describe('atlassian toolkit (OAuth 3LO)', () => {
  it('declares an OAuth scheme with offline access, consent and JSON token requests', () => {
    const o = atlassian.authSchemes[0].oauth2!;
    expect(o.scopes).toContain('offline_access');
    expect(o.authorizeParams).toMatchObject({ audience: 'api.atlassian.com', prompt: 'consent' });
    expect(o.tokenFormat).toBe('json');
    expect(o.provider).toBe('atlassian');
  });

  it('needs a site when the account can reach several, and resolves it by name, URL or id', async () => {
    await expect(run('jira_search_issues', { jql: 'project = ENG' })).rejects.toThrow(/several sites/);
    for (const site of ['beta', 'https://beta.atlassian.net', 'beta.atlassian.net', 'cloud-b']) {
      const r: any = await run('jira_search_issues', { jql: 'project = ENG', site });
      expect(r.cloud).toBe('cloud-b');
    }
    await expect(run('jira_search_issues', { jql: 'x', site: 'nope' })).rejects.toThrow(/Unknown site/);
  });

  it('creates issues with descriptions converted to Atlassian Document Format', async () => {
    const r: any = await run('jira_create_issue', {
      site: 'acme',
      project_key: 'ENG',
      summary: 'Broken build',
      description: 'line one\nline two\n\nsecond paragraph',
      labels: ['ci'],
    });
    expect(r.sent.fields).toMatchObject({
      project: { key: 'ENG' },
      issuetype: { name: 'Task' },
      labels: ['ci'],
    });
    expect(r.sent.fields.description).toEqual(toAdf('line one\nline two\n\nsecond paragraph'));
    expect(r.sent.fields.description.content).toHaveLength(2);
  });

  it('transitions issues and handles the empty 204 reply', async () => {
    const r = await run('jira_transition_issue', {
      site: 'acme',
      issue_key: 'ENG-1',
      transition_id: 31,
      comment: 'done',
    });
    expect(r).toEqual({ transitioned: 'ENG-1', transition_id: '31' });
    const sent = seen.find((s) => s.url.endsWith('/transitions'))!.body;
    expect(sent.transition).toEqual({ id: '31' });
    expect(sent.update.comment[0].add.body.type).toBe('doc');
  });

  it('bumps the Confluence version number on update and keeps the body when only the title changes', async () => {
    const r: any = await run('confluence_update_page', { site: 'acme', page_id: '42', title: 'New title' });
    expect(r.updated.version.number).toBe(8);
    expect(r.updated.title).toBe('New title');
    expect(r.updated.body.value).toBe('<p>old</p>');
  });

  it('identifies the account and rejects path traversal in custom calls', async () => {
    expect(await atlassian.identify!(auth)).toBe('dev@acme.test');
    await expect(
      run('custom_api_call', { product: 'jira', path: '/../../oauth', site: 'acme' }),
    ).rejects.toThrow(/must not contain/);
  });
});
