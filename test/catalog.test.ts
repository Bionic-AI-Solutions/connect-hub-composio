import { describe, expect, it } from 'vitest';
import { Registry } from '../src/catalog/registry.js';
import { normalizeArgs, propToSchema } from '../src/catalog/activepieces.js';
import { mcpToolName } from '../src/mcp/gateway.js';
import { inferAnnotations } from '../src/catalog/annotations.js';

describe('catalog', () => {
  const registry = Registry.default();

  it('loads installed Activepieces pieces plus native toolkits', () => {
    const slugs = registry.listToolkits().map((t) => t.slug);
    for (const s of [
      'github',
      'gmail',
      'google-drive',
      'jira-cloud',
      'confluence',
      'slack',
      'linkedin',
      'youtube',
      'stackexchange',
      'cloudflare',
      'google-analytics',
    ]) {
      expect(slugs).toContain(s);
    }
    const tools = registry.listToolkits().reduce((n, t) => n + t.tools.length, 0);
    expect(tools).toBeGreaterThan(900);
  });

  it('maps piece auth to schemes, with Google quirks for offline tokens', () => {
    const gmail = registry.getToolkit('gmail')!;
    const oauth = gmail.authSchemes.find((s) => s.type === 'OAUTH2')!;
    expect(oauth.oauth2!.provider).toBe('google');
    expect(oauth.oauth2!.authorizeParams.access_type).toBe('offline');
    const jira = registry.getToolkit('jira-cloud')!;
    expect(jira.authSchemes[0].type).toBe('CUSTOM_AUTH');
    expect(jira.authSchemes[0].fields.find((f) => f.name === 'apiToken')?.secret).toBe(true);
  });

  it('builds JSON schemas from piece props', () => {
    const tool = registry.getTool('github.github_create_issue')!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['repository', 'title']));
    expect(tool.inputSchema.properties.title.type).toBe('string');
    expect(tool.dynamicInputs).toContain('repository');
    expect(
      propToSchema({ type: 'STATIC_DROPDOWN', options: { options: [{ label: 'A', value: 'a' }] } }).enum,
    ).toEqual(['a']);
  });

  it('normalizes args: defaults, coercion, required and unknown inputs', async () => {
    const props = {
      a: { type: 'NUMBER', required: true },
      b: { type: 'CHECKBOX', required: false, defaultValue: true },
    } as any;
    expect(await normalizeArgs(props, { a: '3' })).toEqual({ a: 3, b: true });
    await expect(normalizeArgs(props, {})).rejects.toThrow(/Missing required input\(s\): a/);
    await expect(normalizeArgs(props, { a: 1, zzz: 1 })).rejects.toThrow(/Unknown input/);
  });

  it('produces valid MCP tool names', () => {
    for (const tk of registry.listToolkits()) {
      for (const t of tk.tools) expect(mcpToolName(t.slug)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('searches tools', () => {
    const hits = registry.searchTools('create issue', { toolkits: ['github'] });
    expect(hits[0].toolkit).toBe('github');
    expect(hits.some((h) => h.slug === 'github.github_create_issue')).toBe(true);
  });

  it('infers MCP risk annotations conservatively', () => {
    const a = (action: string, displayName = action) =>
      inferAnnotations({ action, displayName, toolkit: 'google-sheets' });
    expect(a('list_projects')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(a('getIssueInformation', 'Get Issue Information')).toMatchObject({ readOnlyHint: true });
    expect(a('find-or-create-row', 'Find or Create Row')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(a('delete_comment')).toMatchObject({ destructiveHint: true });
    expect(a('custom_api_call', 'Custom API Call')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(a('create_issue')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("uses the piece's own READ/SEARCH/WRITE/DESTRUCTIVE label, but a destructive verb or raw call still wins", () => {
    const a = (action: string, classification: any) =>
      inferAnnotations({ action, displayName: action, toolkit: 'reddit', classification });
    // Contains "post", which the name rules treat as a write; the piece says SEARCH.
    expect(a('retrieveRedditPost', 'SEARCH')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(a('fetchPostComments', 'SEARCH')).toMatchObject({ readOnlyHint: true });
    expect(a('lockIssue', 'WRITE')).toMatchObject({ destructiveHint: true });
    expect(a('slack_leave_channel', 'WRITE')).toMatchObject({ destructiveHint: true });
    expect(a('get_thing', 'DESTRUCTIVE')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a('list_things', 'WRITE')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(a('apify_scrape_url', 'READ')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(a('custom_api_call', 'READ')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('catalog pieces carry their classification through to the tool', () => {
    const t = registry.getTool('reddit.retrieveRedditPost');
    expect(t?.classification).toBe('SEARCH');
  });
});
