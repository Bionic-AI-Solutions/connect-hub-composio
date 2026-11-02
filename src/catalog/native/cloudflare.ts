import { bearer, defineToolkit, httpJson } from './define.js';
import { ToolInputError, type ConnectionValue } from '../types.js';

const API = 'https://api.cloudflare.com/client/v4';

const cf = (
  auth: ConnectionValue | undefined,
  path: string,
  init: RequestInit & { query?: Record<string, unknown> } = {},
) =>
  httpJson(`${API}${path}`, {
    ...init,
    headers: { authorization: bearer(auth), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const zoneId = { type: 'string', description: 'Zone id (from cloudflare.list_zones)' };
const record = {
  type: { type: 'string', description: 'Record type: A, AAAA, CNAME, TXT, MX, …' },
  name: { type: 'string', description: 'Record name, e.g. www.example.com' },
  content: { type: 'string', description: 'Record value' },
  ttl: { type: 'number', default: 1, description: 'TTL in seconds (1 = automatic)' },
  proxied: { type: 'boolean' },
  comment: { type: 'string' },
};

export const cloudflare = defineToolkit({
  slug: 'cloudflare',
  name: 'Cloudflare',
  description: 'Manage Cloudflare zones, DNS records, cache and Workers.',
  logoUrl: 'https://www.cloudflare.com/favicon.ico',
  categories: ['DEVELOPER_TOOLS'],
  authSchemes: [
    {
      type: 'SECRET_TEXT',
      displayName: 'API token',
      description: 'Create a scoped API token at dash.cloudflare.com → My Profile → API Tokens.',
      fields: [
        { name: 'secret_text', displayName: 'API token', required: true, secret: true, type: 'string' },
      ],
    },
  ],
  validate: async (auth) => {
    try {
      const r = await cf(auth, '/user/tokens/verify');
      return r?.result?.status === 'active'
        ? { valid: true }
        : { valid: false, error: `Token status: ${r?.result?.status}` };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  },
  tools: [
    {
      name: 'list_accounts',
      displayName: 'List accounts',
      description: 'List Cloudflare accounts the token can access.',
      inputSchema: { type: 'object', properties: {} },
      run: (_a, auth) => cf(auth, '/accounts'),
    },
    {
      name: 'list_zones',
      displayName: 'List zones',
      description: 'List zones (domains), optionally filtered by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          page: { type: 'number' },
          per_page: { type: 'number', default: 50 },
        },
      },
      run: (a, auth) =>
        cf(auth, '/zones', { query: { name: a.name, page: a.page, per_page: a.per_page ?? 50 } }),
    },
    {
      name: 'list_dns_records',
      displayName: 'List DNS records',
      description: 'List DNS records in a zone.',
      inputSchema: {
        type: 'object',
        properties: {
          zone_id: zoneId,
          type: { type: 'string' },
          name: { type: 'string' },
          per_page: { type: 'number', default: 100 },
        },
        required: ['zone_id'],
      },
      run: (a, auth) =>
        cf(auth, `/zones/${encodeURIComponent(a.zone_id)}/dns_records`, {
          query: { type: a.type, name: a.name, per_page: a.per_page ?? 100 },
        }),
    },
    {
      name: 'create_dns_record',
      displayName: 'Create DNS record',
      description: 'Create a DNS record in a zone.',
      inputSchema: {
        type: 'object',
        properties: { zone_id: zoneId, ...record },
        required: ['zone_id', 'type', 'name', 'content'],
      },
      run: ({ zone_id, ...body }, auth) =>
        cf(auth, `/zones/${encodeURIComponent(zone_id)}/dns_records`, {
          method: 'POST',
          body: JSON.stringify({ ttl: 1, ...body }),
        }),
    },
    {
      name: 'update_dns_record',
      displayName: 'Update DNS record',
      description: 'Patch fields of an existing DNS record.',
      inputSchema: {
        type: 'object',
        properties: { zone_id: zoneId, record_id: { type: 'string' }, ...record },
        required: ['zone_id', 'record_id'],
      },
      run: ({ zone_id, record_id, ...body }, auth) =>
        cf(auth, `/zones/${encodeURIComponent(zone_id)}/dns_records/${encodeURIComponent(record_id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
    },
    {
      name: 'delete_dns_record',
      displayName: 'Delete DNS record',
      description: 'Delete a DNS record.',
      inputSchema: {
        type: 'object',
        properties: { zone_id: zoneId, record_id: { type: 'string' } },
        required: ['zone_id', 'record_id'],
      },
      run: (a, auth) =>
        cf(auth, `/zones/${encodeURIComponent(a.zone_id)}/dns_records/${encodeURIComponent(a.record_id)}`, {
          method: 'DELETE',
        }),
    },
    {
      name: 'purge_cache',
      displayName: 'Purge cache',
      description: 'Purge everything, or specific URLs/tags/hosts/prefixes, from a zone cache.',
      inputSchema: {
        type: 'object',
        properties: {
          zone_id: zoneId,
          purge_everything: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          hosts: { type: 'array', items: { type: 'string' } },
          prefixes: { type: 'array', items: { type: 'string' } },
        },
        required: ['zone_id'],
      },
      run: ({ zone_id, ...body }, auth) => {
        if (
          !body.purge_everything &&
          !body.files?.length &&
          !body.tags?.length &&
          !body.hosts?.length &&
          !body.prefixes?.length
        ) {
          throw new ToolInputError('Set purge_everything or give files, tags, hosts or prefixes');
        }
        return cf(auth, `/zones/${encodeURIComponent(zone_id)}/purge_cache`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
    },
    {
      name: 'list_workers',
      displayName: 'List Workers scripts',
      description: 'List Workers scripts in an account.',
      inputSchema: {
        type: 'object',
        properties: { account_id: { type: 'string' } },
        required: ['account_id'],
      },
      run: (a, auth) => cf(auth, `/accounts/${encodeURIComponent(a.account_id)}/workers/scripts`),
    },
    {
      name: 'custom_api_call',
      displayName: 'Custom API call',
      description: 'Call any Cloudflare v4 API endpoint with the connected token.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
          path: { type: 'string', description: 'Path under /client/v4, e.g. /zones' },
          query: { type: 'object', additionalProperties: true },
          body: { description: 'JSON body' },
        },
        required: ['path'],
      },
      run: (a, auth) => {
        if (!String(a.path).startsWith('/')) throw new ToolInputError('path must start with /');
        return cf(auth, a.path, {
          method: a.method ?? 'GET',
          query: a.query,
          body: a.body === undefined ? undefined : JSON.stringify(a.body),
        });
      },
    },
  ],
});
