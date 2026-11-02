import { defineToolkit, httpJson } from './define.js';
import type { ConnectionValue } from '../types.js';

/** Stack Overflow and every other Stack Exchange site, via the public Stack Exchange API v2.3. */
const API = 'https://api.stackexchange.com/2.3';

function keyParam(auth: ConnectionValue | undefined) {
  // Anonymous use is allowed (300 req/day/IP); an app key lifts that to 10k/day.
  return auth?.type === 'SECRET_TEXT' ? { key: auth.secret_text } : {};
}

const site = {
  type: 'string',
  default: 'stackoverflow',
  description:
    'Site API name, e.g. stackoverflow, serverfault, superuser, askubuntu, math (see stackexchange_list_sites).',
};
const pagesize = { type: 'number', default: 10, description: 'Results per page (1-100)' };
const page = { type: 'number', default: 1, description: 'Page number' };

export const stackexchange = defineToolkit({
  slug: 'stackexchange',
  name: 'Stack Exchange (incl. Stack Overflow)',
  description:
    'Search and read questions, answers, tags and users across Stack Overflow and all Stack Exchange sites.',
  logoUrl: 'https://cdn.sstatic.net/Sites/stackoverflow/Img/apple-touch-icon.png',
  categories: ['DEVELOPER_TOOLS'],
  authSchemes: [
    { type: 'NO_AUTH', displayName: 'Anonymous (rate-limited)', fields: [] },
    {
      type: 'SECRET_TEXT',
      displayName: 'App key',
      description: 'Register an app at stackapps.com to get a key with a higher daily quota.',
      fields: [{ name: 'secret_text', displayName: 'App key', required: true, secret: true, type: 'string' }],
    },
  ],
  tools: [
    {
      name: 'search_questions',
      displayName: 'Search questions',
      description: 'Full-text search of questions (title, body, tags) with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free-text query' },
          tagged: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only questions with all these tags',
          },
          accepted: { type: 'boolean', description: 'Only questions with an accepted answer' },
          sort: { enum: ['relevance', 'activity', 'votes', 'creation'], default: 'relevance' },
          site,
          pagesize,
          page,
        },
        required: ['q'],
      },
      run: (a, auth) =>
        httpJson(`${API}/search/advanced`, {
          query: {
            order: 'desc',
            sort: a.sort ?? 'relevance',
            q: a.q,
            tagged: a.tagged,
            accepted: a.accepted,
            site: a.site ?? 'stackoverflow',
            pagesize: a.pagesize ?? 10,
            page: a.page,
            ...keyParam(auth),
          },
        }),
    },
    {
      name: 'get_question',
      displayName: 'Get question with answers',
      description: 'Fetch a question by id including its body and all answers (with bodies).',
      inputSchema: {
        type: 'object',
        properties: { question_id: { type: 'number' }, site },
        required: ['question_id'],
      },
      run: async (a, auth) => {
        const s = a.site ?? 'stackoverflow';
        const q = await httpJson(`${API}/questions/${a.question_id}`, {
          query: { site: s, filter: 'withbody', ...keyParam(auth) },
        });
        const answers = await httpJson(`${API}/questions/${a.question_id}/answers`, {
          query: {
            site: s,
            filter: 'withbody',
            sort: 'votes',
            order: 'desc',
            pagesize: 30,
            ...keyParam(auth),
          },
        });
        return {
          question: q.items?.[0] ?? null,
          answers: answers.items ?? [],
          quota_remaining: answers.quota_remaining,
        };
      },
    },
    {
      name: 'list_tags',
      displayName: 'List tags',
      description: 'List or search tags on a site by popularity.',
      inputSchema: {
        type: 'object',
        properties: { inname: { type: 'string', description: 'Substring to match' }, site, pagesize, page },
      },
      run: (a, auth) =>
        httpJson(`${API}/tags`, {
          query: {
            order: 'desc',
            sort: 'popular',
            inname: a.inname,
            site: a.site ?? 'stackoverflow',
            pagesize: a.pagesize ?? 10,
            page: a.page,
            ...keyParam(auth),
          },
        }),
    },
    {
      name: 'get_users',
      displayName: 'Get users',
      description: 'Look up users by id, or search by display name.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'number' } },
          inname: { type: 'string' },
          site,
          pagesize,
        },
      },
      run: (a, auth) => {
        const path = a.ids?.length ? `/users/${a.ids.join(';')}` : '/users';
        return httpJson(`${API}${path}`, {
          query: {
            order: 'desc',
            sort: 'reputation',
            inname: a.inname,
            site: a.site ?? 'stackoverflow',
            pagesize: a.pagesize ?? 10,
            ...keyParam(auth),
          },
        });
      },
    },
    {
      name: 'list_sites',
      displayName: 'List Stack Exchange sites',
      description: 'List all Stack Exchange sites and their API names.',
      inputSchema: { type: 'object', properties: { pagesize: { type: 'number', default: 100 }, page } },
      run: (a, auth) =>
        httpJson(`${API}/sites`, { query: { pagesize: a.pagesize ?? 100, page: a.page, ...keyParam(auth) } }),
    },
  ],
});
