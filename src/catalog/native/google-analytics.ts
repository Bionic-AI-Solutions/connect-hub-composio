import { bearer, defineToolkit, httpJson } from './define.js';
import { providerAuthorizeParams } from '../providers.js';
import type { ConnectionValue } from '../types.js';

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';

const ga = (
  auth: ConnectionValue | undefined,
  url: string,
  init: RequestInit & { query?: Record<string, unknown> } = {},
) =>
  httpJson(url, {
    ...init,
    headers: { authorization: bearer(auth), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const property = {
  type: 'string',
  description: 'GA4 property id, e.g. 123456789 (from google-analytics.list_account_summaries)',
};
const names = (desc: string) => ({ type: 'array', items: { type: 'string' }, description: desc });

const prop = (id: string) => `properties/${String(id).replace(/^properties\//, '')}`;

export const googleAnalytics = defineToolkit({
  slug: 'google-analytics',
  name: 'Google Analytics (GA4)',
  description: 'List GA4 accounts and properties and run reports with the Analytics Data API.',
  logoUrl: 'https://www.gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg',
  categories: ['MARKETING', 'BUSINESS_INTELLIGENCE'],
  authSchemes: [
    {
      type: 'OAUTH2',
      displayName: 'Google account',
      fields: [],
      oauth2: {
        authUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/analytics.readonly', 'email'],
        pkce: true,
        pkceMethod: 'S256',
        authorizeParams: providerAuthorizeParams('google'),
        clientAuth: 'body',
        provider: 'google',
      },
    },
  ],
  identify: async (auth) => {
    try {
      const me = await ga(auth, 'https://openidconnect.googleapis.com/v1/userinfo');
      return me?.email;
    } catch {
      return undefined;
    }
  },
  tools: [
    {
      name: 'list_account_summaries',
      displayName: 'List accounts and properties',
      description: 'List every GA4 account and its properties the user can access.',
      inputSchema: {
        type: 'object',
        properties: { pageSize: { type: 'number', default: 200 }, pageToken: { type: 'string' } },
      },
      run: (a, auth) =>
        ga(auth, `${ADMIN}/accountSummaries`, {
          query: { pageSize: a.pageSize ?? 200, pageToken: a.pageToken },
        }),
    },
    {
      name: 'run_report',
      displayName: 'Run report',
      description: 'Run a GA4 report: metrics broken down by dimensions over one or more date ranges.',
      inputSchema: {
        type: 'object',
        properties: {
          property,
          metrics: names('Metric names, e.g. activeUsers, sessions, screenPageViews, conversions'),
          dimensions: names('Dimension names, e.g. date, country, pagePath, sessionSource'),
          start_date: {
            type: 'string',
            default: '28daysAgo',
            description: 'YYYY-MM-DD, or NdaysAgo / yesterday / today',
          },
          end_date: { type: 'string', default: 'today' },
          limit: { type: 'number', default: 100 },
          order_by_metric: { type: 'string', description: 'Sort descending by this metric' },
          dimension_filter: {
            type: 'object',
            additionalProperties: true,
            description: 'Raw GA4 FilterExpression',
          },
        },
        required: ['property', 'metrics'],
      },
      run: (a, auth) =>
        ga(auth, `${DATA}/${prop(a.property)}:runReport`, {
          method: 'POST',
          body: JSON.stringify({
            metrics: a.metrics.map((name: string) => ({ name })),
            dimensions: (a.dimensions ?? []).map((name: string) => ({ name })),
            dateRanges: [{ startDate: a.start_date ?? '28daysAgo', endDate: a.end_date ?? 'today' }],
            limit: a.limit ?? 100,
            ...(a.order_by_metric
              ? { orderBys: [{ metric: { metricName: a.order_by_metric }, desc: true }] }
              : {}),
            ...(a.dimension_filter ? { dimensionFilter: a.dimension_filter } : {}),
          }),
        }),
    },
    {
      name: 'run_realtime_report',
      displayName: 'Run realtime report',
      description: 'Activity in the last 30 minutes.',
      inputSchema: {
        type: 'object',
        properties: {
          property,
          metrics: names('e.g. activeUsers'),
          dimensions: names('e.g. country, unifiedScreenName'),
          limit: { type: 'number', default: 50 },
        },
        required: ['property', 'metrics'],
      },
      run: (a, auth) =>
        ga(auth, `${DATA}/${prop(a.property)}:runRealtimeReport`, {
          method: 'POST',
          body: JSON.stringify({
            metrics: a.metrics.map((name: string) => ({ name })),
            dimensions: (a.dimensions ?? []).map((name: string) => ({ name })),
            limit: a.limit ?? 50,
          }),
        }),
    },
    {
      name: 'get_metadata',
      displayName: 'List available dimensions and metrics',
      description: 'Dimensions and metrics (including custom ones) available for a property.',
      inputSchema: { type: 'object', properties: { property }, required: ['property'] },
      run: (a, auth) => ga(auth, `${DATA}/${prop(a.property)}/metadata`),
    },
  ],
});
