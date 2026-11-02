/**
 * Jira + Confluence over Atlassian OAuth 2.0 (3LO). Users sign in with their Atlassian account instead of pasting
 * an API token; calls go through the api.atlassian.com gateway, addressed by the site's cloud id.
 *
 * The Activepieces `jira-cloud` / `confluence` toolkits stay available for API-token connections.
 */
import { bearer, defineToolkit, httpJson } from './define.js';
import { providerAuthorizeParams } from '../providers.js';
import { ToolInputError, type ConnectionValue } from '../types.js';

/** Overridable for tests. */
const apiBase = () => (process.env.ATLASSIAN_API_BASE ?? 'https://api.atlassian.com').replace(/\/+$/, '');

type Resource = { id: string; name: string; url: string; scopes: string[] };

async function sites(auth: ConnectionValue | undefined): Promise<Resource[]> {
  return httpJson(`${apiBase()}/oauth/token/accessible-resources`, {
    headers: { authorization: bearer(auth) },
  });
}

/** Resolve a site (name, URL or cloud id) to its cloud id. Defaults to the only site when there is exactly one. */
async function cloudId(auth: ConnectionValue | undefined, site: unknown): Promise<string> {
  const all = await sites(auth);
  if (!all.length) throw new ToolInputError('This Atlassian account has not granted access to any site');
  if (site === undefined || site === null || site === '') {
    if (all.length === 1) return all[0].id;
    throw new ToolInputError(
      `This account can reach several sites; pass "site" as one of: ${all.map((r) => r.url).join(', ')}`,
    );
  }
  const want = String(site).toLowerCase().replace(/\/+$/, '');
  const hit = all.find(
    (r) =>
      r.id === site ||
      r.url.toLowerCase() === want ||
      r.url.toLowerCase() === `https://${want}` ||
      r.url.toLowerCase() === `https://${want}.atlassian.net` ||
      r.name.toLowerCase() === want,
  );
  if (!hit)
    throw new ToolInputError(`Unknown site "${site}". Available: ${all.map((r) => r.url).join(', ')}`);
  return hit.id;
}

const jira = async (
  auth: ConnectionValue | undefined,
  site: unknown,
  path: string,
  init: RequestInit & { query?: Record<string, unknown> } = {},
) =>
  httpJson(`${apiBase()}/ex/jira/${await cloudId(auth, site)}/rest/api/3${path}`, {
    ...init,
    headers: { authorization: bearer(auth), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const confluence = async (
  auth: ConnectionValue | undefined,
  site: unknown,
  path: string,
  init: RequestInit & { query?: Record<string, unknown> } = {},
) =>
  httpJson(`${apiBase()}/ex/confluence/${await cloudId(auth, site)}/wiki${path}`, {
    ...init,
    headers: { authorization: bearer(auth), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

/** Plain text → Atlassian Document Format (paragraphs split on blank lines, line breaks kept). */
export function toAdf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: String(text)
      .split(/\n{2,}/)
      .map((para) => ({
        type: 'paragraph',
        content: para
          .split('\n')
          .flatMap((line, i) => [
            ...(i ? [{ type: 'hardBreak' }] : []),
            ...(line ? [{ type: 'text', text: line }] : []),
          ]),
      })),
  };
}

const site = {
  type: 'string',
  description:
    'Site URL (https://acme.atlassian.net), name or cloud id. Optional when the account has one site.',
};
const issueKey = { type: 'string', description: 'Issue key, e.g. ENG-123' };
const enc = encodeURIComponent;

export const atlassian = defineToolkit({
  slug: 'atlassian',
  name: 'Atlassian (Jira + Confluence, OAuth)',
  description: 'Jira issues and Confluence pages through Atlassian OAuth 2.0 — users sign in, no API tokens.',
  logoUrl: 'https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png',
  categories: ['PRODUCTIVITY', 'DEVELOPER_TOOLS'],
  authSchemes: [
    {
      type: 'OAUTH2',
      displayName: 'Atlassian account',
      fields: [],
      oauth2: {
        authUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: [
          'read:jira-work',
          'write:jira-work',
          'read:jira-user',
          'read:confluence-content.all',
          'write:confluence-content',
          'read:confluence-space.summary',
          'search:confluence',
          'read:me',
          'offline_access',
        ],
        pkce: false,
        pkceMethod: 'S256',
        authorizeParams: providerAuthorizeParams('atlassian'),
        clientAuth: 'body',
        tokenFormat: 'json',
        provider: 'atlassian',
      },
    },
  ],
  identify: async (auth) => {
    try {
      const me = await httpJson(`${apiBase()}/me`, { headers: { authorization: bearer(auth) } });
      return me?.email ?? me?.name;
    } catch {
      return undefined;
    }
  },
  tools: [
    {
      name: 'list_sites',
      displayName: 'List sites',
      description: 'Atlassian sites (Jira/Confluence clouds) this account granted access to.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: async (_a, auth) =>
        (await sites(auth)).map(({ id, name, url, scopes }) => ({ id, name, url, scopes })),
    },
    // ── Jira ──────────────────────────────────────────────────────────────
    {
      name: 'jira_search_issues',
      displayName: 'Search Jira issues (JQL)',
      description: 'Search issues with JQL, e.g. project = ENG AND status != Done ORDER BY updated DESC.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          jql: { type: 'string' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            default: ['summary', 'status', 'assignee', 'priority', 'updated'],
          },
          max_results: { type: 'number', default: 25 },
          next_page_token: { type: 'string' },
        },
        required: ['jql'],
      },
      run: (a, auth) =>
        jira(auth, a.site, '/search/jql', {
          query: {
            jql: a.jql,
            fields: (a.fields ?? ['summary', 'status', 'assignee', 'priority', 'updated']).join(','),
            maxResults: a.max_results ?? 25,
            nextPageToken: a.next_page_token,
          },
        }),
    },
    {
      name: 'jira_get_issue',
      displayName: 'Get Jira issue',
      description: 'Fetch one issue with its fields.',
      inputSchema: {
        type: 'object',
        properties: { site, issue_key: issueKey, fields: { type: 'array', items: { type: 'string' } } },
        required: ['issue_key'],
      },
      run: (a, auth) =>
        jira(auth, a.site, `/issue/${enc(a.issue_key)}`, { query: { fields: a.fields?.join(',') } }),
    },
    {
      name: 'jira_create_issue',
      displayName: 'Create Jira issue',
      description:
        'Create an issue. Description is plain text; extra fields go in "fields" as Jira field ids.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          project_key: { type: 'string' },
          issue_type: { type: 'string', default: 'Task', description: 'Task, Bug, Story, Epic…' },
          summary: { type: 'string' },
          description: { type: 'string' },
          assignee_account_id: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          fields: { type: 'object', additionalProperties: true },
        },
        required: ['project_key', 'summary'],
      },
      run: (a, auth) =>
        jira(auth, a.site, '/issue', {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              project: { key: a.project_key },
              issuetype: { name: a.issue_type ?? 'Task' },
              summary: a.summary,
              ...(a.description ? { description: toAdf(a.description) } : {}),
              ...(a.assignee_account_id ? { assignee: { accountId: a.assignee_account_id } } : {}),
              ...(a.labels ? { labels: a.labels } : {}),
              ...(a.fields ?? {}),
            },
          }),
        }),
    },
    {
      name: 'jira_update_issue',
      displayName: 'Update Jira issue',
      description: 'Change summary, description or other fields of an issue.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          issue_key: issueKey,
          summary: { type: 'string' },
          description: { type: 'string' },
          fields: { type: 'object', additionalProperties: true },
        },
        required: ['issue_key'],
      },
      run: async (a, auth) => {
        const fields = {
          ...(a.summary ? { summary: a.summary } : {}),
          ...(a.description ? { description: toAdf(a.description) } : {}),
          ...(a.fields ?? {}),
        };
        if (!Object.keys(fields).length) throw new ToolInputError('Nothing to update');
        await jira(auth, a.site, `/issue/${enc(a.issue_key)}`, {
          method: 'PUT',
          body: JSON.stringify({ fields }),
        });
        return { updated: a.issue_key };
      },
    },
    {
      name: 'jira_add_comment',
      displayName: 'Comment on Jira issue',
      description: 'Add a plain-text comment to an issue.',
      inputSchema: {
        type: 'object',
        properties: { site, issue_key: issueKey, body: { type: 'string' } },
        required: ['issue_key', 'body'],
      },
      run: (a, auth) =>
        jira(auth, a.site, `/issue/${enc(a.issue_key)}/comment`, {
          method: 'POST',
          body: JSON.stringify({ body: toAdf(a.body) }),
        }),
    },
    {
      name: 'jira_get_transitions',
      displayName: 'List Jira transitions',
      description: 'Workflow transitions available for an issue (ids for jira_transition_issue).',
      inputSchema: { type: 'object', properties: { site, issue_key: issueKey }, required: ['issue_key'] },
      annotations: { readOnlyHint: true },
      run: (a, auth) => jira(auth, a.site, `/issue/${enc(a.issue_key)}/transitions`),
    },
    {
      name: 'jira_transition_issue',
      displayName: 'Move Jira issue to another status',
      description: 'Apply a workflow transition (from jira_get_transitions), optionally with a comment.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          issue_key: issueKey,
          transition_id: { type: 'string' },
          comment: { type: 'string' },
        },
        required: ['issue_key', 'transition_id'],
      },
      run: async (a, auth) => {
        await jira(auth, a.site, `/issue/${enc(a.issue_key)}/transitions`, {
          method: 'POST',
          body: JSON.stringify({
            transition: { id: String(a.transition_id) },
            ...(a.comment ? { update: { comment: [{ add: { body: toAdf(a.comment) } }] } } : {}),
          }),
        });
        return { transitioned: a.issue_key, transition_id: String(a.transition_id) };
      },
    },
    {
      name: 'jira_assign_issue',
      displayName: 'Assign Jira issue',
      description: 'Assign an issue to a user (account id from jira_search_users), or unassign with null.',
      inputSchema: {
        type: 'object',
        properties: { site, issue_key: issueKey, account_id: { type: ['string', 'null'] } },
        required: ['issue_key'],
      },
      run: async (a, auth) => {
        await jira(auth, a.site, `/issue/${enc(a.issue_key)}/assignee`, {
          method: 'PUT',
          body: JSON.stringify({ accountId: a.account_id ?? null }),
        });
        return { assigned: a.issue_key, account_id: a.account_id ?? null };
      },
    },
    {
      name: 'jira_list_projects',
      displayName: 'List Jira projects',
      description: 'Projects visible to the user, optionally filtered by name or key.',
      inputSchema: {
        type: 'object',
        properties: { site, query: { type: 'string' }, max_results: { type: 'number', default: 50 } },
      },
      run: (a, auth) =>
        jira(auth, a.site, '/project/search', { query: { query: a.query, maxResults: a.max_results ?? 50 } }),
    },
    {
      name: 'jira_search_users',
      displayName: 'Find Jira users',
      description: 'Find users by name or email to get their account id.',
      inputSchema: { type: 'object', properties: { site, query: { type: 'string' } }, required: ['query'] },
      run: (a, auth) => jira(auth, a.site, '/user/search', { query: { query: a.query } }),
    },
    // ── Confluence ────────────────────────────────────────────────────────
    {
      name: 'confluence_search',
      displayName: 'Search Confluence (CQL)',
      description: 'Search content with CQL, e.g. type = page AND text ~ "onboarding".',
      inputSchema: {
        type: 'object',
        properties: { site, cql: { type: 'string' }, limit: { type: 'number', default: 25 } },
        required: ['cql'],
      },
      run: (a, auth) =>
        confluence(auth, a.site, '/rest/api/search', { query: { cql: a.cql, limit: a.limit ?? 25 } }),
    },
    {
      name: 'confluence_list_spaces',
      displayName: 'List Confluence spaces',
      description: 'Spaces the user can see (ids are needed to create pages).',
      inputSchema: {
        type: 'object',
        properties: { site, limit: { type: 'number', default: 50 }, cursor: { type: 'string' } },
      },
      run: (a, auth) =>
        confluence(auth, a.site, '/api/v2/spaces', { query: { limit: a.limit ?? 50, cursor: a.cursor } }),
    },
    {
      name: 'confluence_get_page',
      displayName: 'Get Confluence page',
      description: 'Fetch a page with its body in storage format.',
      inputSchema: {
        type: 'object',
        properties: { site, page_id: { type: 'string' } },
        required: ['page_id'],
      },
      run: (a, auth) =>
        confluence(auth, a.site, `/api/v2/pages/${enc(a.page_id)}`, { query: { 'body-format': 'storage' } }),
    },
    {
      name: 'confluence_create_page',
      displayName: 'Create Confluence page',
      description: 'Create a page in a space. Body is Confluence storage format (XHTML), e.g. <p>Hello</p>.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          space_id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          parent_id: { type: 'string' },
        },
        required: ['space_id', 'title', 'body'],
      },
      run: (a, auth) =>
        confluence(auth, a.site, '/api/v2/pages', {
          method: 'POST',
          body: JSON.stringify({
            spaceId: a.space_id,
            status: 'current',
            title: a.title,
            ...(a.parent_id ? { parentId: a.parent_id } : {}),
            body: { representation: 'storage', value: a.body },
          }),
        }),
    },
    {
      name: 'confluence_update_page',
      displayName: 'Update Confluence page',
      description:
        'Replace a page title and/or body (storage format). The version number is handled for you.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          page_id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          version_message: { type: 'string' },
        },
        required: ['page_id'],
      },
      run: async (a, auth) => {
        if (!a.title && a.body === undefined) throw new ToolInputError('Give a title and/or body');
        const current = await confluence(auth, a.site, `/api/v2/pages/${enc(a.page_id)}`, {
          query: { 'body-format': 'storage' },
        });
        return confluence(auth, a.site, `/api/v2/pages/${enc(a.page_id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            id: a.page_id,
            status: 'current',
            title: a.title ?? current.title,
            body: { representation: 'storage', value: a.body ?? current.body?.storage?.value ?? '' },
            version: { number: (current.version?.number ?? 0) + 1, message: a.version_message },
          }),
        });
      },
    },
    {
      name: 'custom_api_call',
      displayName: 'Custom API call',
      description:
        'Call any Jira (/rest/api/3/…) or Confluence (/wiki/…) endpoint on a site with this account.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          product: { enum: ['jira', 'confluence'] },
          method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
          path: {
            type: 'string',
            description: 'Jira: path under /rest/api/3, e.g. /myself. Confluence: path under /wiki.',
          },
          query: { type: 'object', additionalProperties: true },
          body: { description: 'JSON body' },
        },
        required: ['product', 'path'],
      },
      run: (a, auth) => {
        if (!String(a.path).startsWith('/') || String(a.path).includes('..'))
          throw new ToolInputError('path must start with / and must not contain ..');
        const init = {
          method: a.method ?? 'GET',
          query: a.query,
          body: a.body === undefined ? undefined : JSON.stringify(a.body),
        };
        return a.product === 'jira'
          ? jira(auth, a.site, a.path, init)
          : confluence(auth, a.site, a.path, init);
      },
    },
  ],
});
