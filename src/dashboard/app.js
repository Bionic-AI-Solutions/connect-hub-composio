// Connect Hub dashboard. Plain JS, no build step. Everything is rendered with textContent and DOM node APIs (no HTML-string
// APIs at all) so tenant-controlled data cannot inject markup. The API key lives in sessionStorage for this tab only.
'use strict';

const KEY = 'connect-hub.api-key';
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

function getKey() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function setKey(v) {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: key lives only in memory */
  }
  memKey = v;
}
let memKey = getKey();

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${memKey}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    setKey(null);
    showLogin('Your session ended. Sign in again.');
    throw new Error('unauthorized');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3000);
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const status = (s) => el('span', { class: `status-${s}` }, s);
const copyBtn = (text, label = 'Copy') =>
  el(
    'button',
    {
      class: 'ghost small',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied');
        } catch {
          toast('Copy failed — select and copy manually', true);
        }
      },
    },
    label,
  );

function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return el('div', { class: 'empty' }, empty);
  const cell = (c) => (c instanceof Node && c.tagName === 'TD' ? c : el('td', {}, c));
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          cols.map((c) => el('th', {}, c)),
        ),
      ),
      el(
        'tbody',
        {},
        rows.map((r) => el('tr', {}, r.map(cell))),
      ),
    ),
  );
}
/** A right-aligned table cell holding row buttons. */
const actions = (...btns) => el('td', { class: 'actions' }, ...btns);

function secretBox(title, value, note) {
  return el(
    'div',
    { class: 'secret' },
    el('strong', {}, title),
    el('div', {}, el('code', {}, value), ' ', copyBtn(value)),
    el('div', { class: 'muted' }, note),
  );
}

async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message, true);
    return undefined;
  }
}

function form(onSubmit, ...children) {
  return el(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        const btn = f.querySelector('button[type=submit]');
        if (btn) btn.disabled = true;
        try {
          await onSubmit(new FormData(f), f);
        } finally {
          if (btn) btn.disabled = false;
        }
      },
    },
    ...children,
  );
}
const field = (label, input) => el('div', {}, el('label', {}, label), input);
const parseList = (s) =>
  String(s || '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const ME = 'connect-hub.me';
function getMe() {
  try {
    return localStorage.getItem(ME) || '';
  } catch {
    return '';
  }
}
function setMe(v) {
  try {
    if (v) localStorage.setItem(ME, v);
    else localStorage.removeItem(ME);
  } catch {
    /* Storage may be blocked; the field just will not be remembered. */
  }
}

/** Guided one-time OAuth app setup for a provider: where to register, what to paste back. */
function providerSetupCard(p, onSaved, onClose) {
  const step = (n, title, ...body) => el('li', {}, el('strong', {}, title), ...body);
  return el(
    'div',
    { class: 'card setup' },
    el(
      'div',
      { class: 'head' },
      el(
        'div',
        {},
        el('h2', {}, `Set up ${p.name} sign-in`),
        el('div', { class: 'muted' }, `Once, for: ${p.toolkits.map((t) => t.name).join(', ')}`),
      ),
      el('button', { class: 'ghost small', onclick: onClose }, 'Close'),
    ),
    el(
      'ol',
      { class: 'steps' },
      step(
        1,
        `Create an OAuth app in ${p.name}`,
        el(
          'div',
          {},
          p.console_url
            ? el(
                'a',
                { class: 'button small', href: p.console_url, target: '_blank', rel: 'noopener noreferrer' },
                `Open ${p.name} developer console ↗`,
              )
            : el('span', { class: 'muted' }, 'Use the provider’s developer console.'),
        ),
        p.note ? el('div', { class: 'muted' }, p.note) : null,
      ),
      step(
        2,
        'Use this callback (redirect) URL',
        el('div', {}, el('code', {}, p.callback_url), ' ', copyBtn(p.callback_url)),
      ),
      p.scopes.length
        ? step(
            3,
            'Allow these scopes',
            el(
              'div',
              {},
              p.scopes.map((x) => el('span', { class: 'chip' }, x)),
            ),
          )
        : null,
      step(
        p.scopes.length ? 4 : 3,
        'Paste the app’s client ID and secret',
        form(
          async (fd) => {
            const r = await guard(
              () =>
                api('PUT', `/v1/oauth-providers/${encodeURIComponent(p.provider)}`, {
                  client_id: fd.get('client_id'),
                  client_secret: fd.get('client_secret'),
                }),
              `${p.name} sign-in saved`,
            );
            if (r) await onSaved(r);
          },
          el(
            'div',
            { class: 'row' },
            field(
              'Client ID',
              el('input', {
                name: 'client_id',
                required: true,
                value: p.client_id || '',
                autocomplete: 'off',
              }),
            ),
            field(
              'Client secret',
              el('input', { name: 'client_secret', type: 'password', required: true, autocomplete: 'off' }),
            ),
          ),
          el('div', { class: 'muted' }, 'The secret is encrypted and never shown again.'),
          el('button', { type: 'submit' }, 'Save'),
        ),
      ),
    ),
  );
}

// ───────────────────────────── views ─────────────────────────────

const views = {
  async overview(v) {
    const [usage, accounts, servers, subs] = await Promise.all([
      api('GET', '/v1/usage'),
      api('GET', '/v1/connected-accounts'),
      api('GET', '/v1/mcp-servers'),
      api('GET', '/v1/trigger-subscriptions'),
    ]);
    const limit = (n) => (n === null ? 'no limit' : `limit ${n.toLocaleString()}`);
    const stat = (n, l) =>
      el(
        'div',
        { class: 'card stat' },
        el('div', { class: 'n' }, n.toLocaleString()),
        el('div', { class: 'l' }, l),
      );
    v.append(
      el(
        'div',
        { class: 'head' },
        el(
          'div',
          {},
          el('h1', {}, 'Overview'),
          el('div', { class: 'muted' }, `Usage for ${usage.period} (UTC)`),
        ),
      ),
      el(
        'div',
        { class: 'stats' },
        stat(usage.tool_calls, `tool calls · ${limit(usage.limits.monthly_tool_call_limit)}`),
        stat(usage.failed_calls, 'failed calls'),
        stat(usage.trigger_events, 'trigger events'),
        stat(accounts.items.length, 'connected accounts'),
        stat(servers.items.length, 'MCP servers'),
        stat(subs.items.length, 'trigger subscriptions'),
      ),
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Rate limit'),
        el(
          'div',
          {},
          usage.limits.rate_limit_per_minute === null
            ? 'No per-minute limit.'
            : `${usage.limits.rate_limit_per_minute} tool calls per minute.`,
        ),
      ),
    );
  },

  async apps(v) {
    const me = getMe();
    const [{ items }, { items: providers }] = await Promise.all([
      api('GET', `/v1/apps${me ? `?user_id=${encodeURIComponent(me)}` : ''}`),
      api('GET', '/v1/oauth-providers'),
    ]);
    const byProvider = new Map(providers.map((p) => [p.provider, p]));
    const panel = el('div');
    const grid = el('div', { class: 'grid-apps' });

    const connect = async (app, scheme) => {
      const user = getMe();
      if (!user) {
        toast('Enter who you are connecting as first.', true);
        $('#me-input')?.focus();
        return;
      }
      const r = await guard(() =>
        api('POST', '/v1/connected-accounts/link', {
          user_id: user,
          toolkit: app.slug,
          scheme,
          redirect_url: `${location.origin}/dashboard#apps`,
        }),
      );
      // Same tab: the provider's sign-in page, then straight back here. The API key stays in this tab's session.
      if (r) location.assign(r.connect_url);
    };
    const statusLine = (app) => {
      if (app.accounts.active)
        return el(
          'span',
          { class: 'status-ACTIVE' },
          `Connected${app.accounts.active > 1 ? ` (${app.accounts.active})` : ''}`,
        );
      if (app.accounts.needs_attention) return el('span', { class: 'status-EXPIRED' }, 'Needs sign-in again');
      if (needsSignInSetup(app)) return el('span', { class: 'muted' }, 'Sign-in not set up yet');
      if (app.connect === 'none') return el('span', { class: 'muted' }, 'No sign-in needed');
      return el('span', { class: 'muted' }, 'Not connected');
    };
    const needsSignInSetup = (app) => app.oauth_provider && app.oauth_source === 'none';
    const primary = (app) => {
      if (app.connect === 'none') return null;
      if (needsSignInSetup(app))
        return el(
          'button',
          { class: 'small', onclick: () => showSetup(byProvider.get(app.oauth_provider), app) },
          'Set up sign-in',
        );
      return el(
        'button',
        { class: app.accounts.active ? 'ghost small' : 'small', onclick: () => connect(app) },
        app.accounts.active ? 'Connect another' : app.accounts.needs_attention ? 'Reconnect' : 'Connect',
      );
    };
    const secondary = (app) =>
      needsSignInSetup(app) && app.other_schemes.length
        ? el(
            'button',
            {
              class: 'ghost small',
              title: 'Connect with an API key or service account instead',
              onclick: () => connect(app, app.other_schemes[0]),
            },
            'Use a key instead',
          )
        : null;
    const render = (q) => {
      grid.replaceChildren(
        ...items
          .filter((t) => !q || `${t.slug} ${t.name}`.toLowerCase().includes(q.toLowerCase()))
          .map((app) =>
            el(
              'div',
              { class: 'card app' },
              app.logo_url
                ? el('img', { src: app.logo_url, alt: '' })
                : el('div', { class: 'logo-fallback' }, app.name[0]),
              el('div', { class: 'grow' }, el('div', { class: 'name' }, app.name), statusLine(app)),
              el(
                'div',
                { class: 'app-actions' },
                primary(app),
                secondary(app),
                el('button', { class: 'ghost small', onclick: () => showDetail(app) }, 'Details'),
              ),
            ),
          ),
      );
    };

    // One-time OAuth app for a whole provider (Google covers Gmail, Drive, Sheets…). After this, Connect is one click.
    const showSetup = (p, app) => {
      if (!p) return;
      panel.replaceChildren(
        providerSetupCard(
          p,
          async () => {
            panel.replaceChildren();
            await route();
            if (app) toast(`${p.name} sign-in is ready. Click Connect on ${app.name}.`);
          },
          () => panel.replaceChildren(),
        ),
      );
      panel.scrollIntoView({ behavior: 'smooth' });
    };

    const showDetail = async (app) => {
      const t = await guard(() => api('GET', `/v1/toolkits/${encodeURIComponent(app.slug)}`));
      if (!t) return;
      const result = el('div');
      panel.replaceChildren(
        el(
          'div',
          { class: 'card' },
          el(
            'div',
            { class: 'head' },
            el('div', {}, el('h2', {}, t.name), el('div', { class: 'muted' }, t.description)),
            el('button', { class: 'ghost small', onclick: () => panel.replaceChildren() }, 'Close'),
          ),
          el(
            'div',
            {},
            'Sign-in: ',
            t.auth_schemes.map((s) => el('span', { class: 'chip' }, s.display_name || s.type)),
          ),
          el('h2', { class: 'mt' }, 'Connect someone else'),
          form(
            async (fd) => {
              const r = await guard(() =>
                api('POST', '/v1/connected-accounts/link', { user_id: fd.get('user_id'), toolkit: app.slug }),
              );
              if (r)
                result.replaceChildren(
                  el(
                    'div',
                    { class: 'secret' },
                    el('strong', {}, 'Connect link (valid until ', fmt(r.expires_at), ')'),
                    el('div', {}, el('code', {}, r.connect_url), ' ', copyBtn(r.connect_url)),
                    el('div', { class: 'muted' }, 'Send this to the person who owns the account.'),
                  ),
                );
            },
            el(
              'div',
              { class: 'row' },
              field(
                'Their email or user ID',
                el('input', { name: 'user_id', placeholder: 'person@company.com', required: true }),
              ),
            ),
            el('button', { type: 'submit', class: 'ghost' }, 'Create link'),
          ),
          result,
          el('h2', { class: 'mt' }, `Tools (${t.tools.length})`),
          table(
            ['Tool', 'Description'],
            t.tools.map((x) => [el('code', {}, x.slug), x.description]),
          ),
        ),
      );
      panel.scrollIntoView({ behavior: 'smooth' });
    };

    const meForm = form(
      async (fd) => {
        setMe(String(fd.get('me') || '').trim());
        await route();
      },
      el(
        'div',
        { class: 'row' },
        field(
          'Connecting as',
          el('input', {
            id: 'me-input',
            name: 'me',
            value: me || '',
            placeholder: 'you@company.com',
            required: true,
          }),
        ),
      ),
      el('button', { type: 'submit', class: 'ghost' }, me ? 'Change' : 'Save'),
    );
    v.append(
      el(
        'div',
        { class: 'head' },
        el(
          'div',
          {},
          el('h1', {}, 'Apps'),
          el(
            'div',
            { class: 'muted' },
            'Click an app, sign in, and the hub keeps the connection. Agents then act as this user.',
          ),
        ),
      ),
      el(
        'div',
        { class: 'card' },
        meForm,
        el(
          'div',
          { class: 'muted' },
          'Use the same email you sign in to Paperclip with, so its agents find these connections.',
        ),
        el('input', { class: 'mt', placeholder: 'Search apps…', oninput: (e) => render(e.target.value) }),
      ),
      panel,
      grid,
    );
    render('');
  },

  async accounts(v) {
    const list = el('div');
    const load = async (user) => {
      const { items } = await api(
        'GET',
        `/v1/connected-accounts${user ? `?user_id=${encodeURIComponent(user)}` : ''}`,
      );
      list.replaceChildren(
        table(
          ['User', 'App', 'Status', 'Account', 'Token expires', 'Connected', ''],
          items.map((a) => [
            a.user_id,
            a.toolkit,
            status(a.status),
            a.identifier || '—',
            fmt(a.expires_at),
            fmt(a.created_at),
            actions(
              a.scheme === 'OAUTH2'
                ? el(
                    'button',
                    {
                      class: 'ghost small',
                      onclick: async () =>
                        (await guard(
                          () => api('POST', `/v1/connected-accounts/${a.id}/refresh`),
                          'Refreshed',
                        )) && load(user),
                    },
                    'Refresh',
                  )
                : null,
              el(
                'button',
                {
                  class: 'danger small',
                  onclick: async () =>
                    confirm(`Disconnect ${a.toolkit} for ${a.user_id}?`) &&
                    (await guard(() => api('DELETE', `/v1/connected-accounts/${a.id}`), 'Disconnected')) !==
                      undefined &&
                    load(user),
                },
                'Disconnect',
              ),
            ),
          ]),
          'No connected accounts.',
        ),
      );
    };
    v.append(
      el('div', { class: 'head' }, el('h1', {}, 'Connected accounts')),
      el(
        'div',
        { class: 'card' },
        form(
          async (fd) => load(fd.get('user')),
          el(
            'div',
            { class: 'row' },
            field('Filter by user', el('input', { name: 'user', placeholder: 'All users' })),
          ),
          el('button', { type: 'submit' }, 'Filter'),
        ),
        list,
      ),
    );
    await load('');
  },

  async servers(v) {
    const [{ items: toolkits }, servers, grants] = await Promise.all([
      api('GET', '/v1/toolkits'),
      api('GET', '/v1/mcp-servers'),
      api('GET', '/v1/mcp-oauth-grants'),
    ]);
    const out = el('div');
    const datalist = el(
      'datalist',
      { id: 'toolkit-list' },
      toolkits.map((t) => el('option', { value: t.slug }, t.name)),
    );
    const serverRows = servers.items.map((s) => [
      el(
        'div',
        {},
        el('strong', {}, s.name),
        el('div', {}, el('code', {}, s.url), ' ', copyBtn(s.url, 'Copy URL')),
      ),
      s.toolkits.map((t) => el('span', { class: 'chip' }, t)),
      `${s.mode} · ${s.connect_handoff}`,
      actions(
        el(
          'button',
          {
            class: 'ghost small',
            onclick: async () => {
              const user = prompt('Issue a token for which user? (email, agent:<id> or company:<id>)');
              if (!user) return;
              const r = await guard(() => api('POST', `/v1/mcp-servers/${s.id}/tokens`, { user_id: user }));
              if (r)
                out.replaceChildren(
                  secretBox(
                    `Token for ${user} on ${s.name}`,
                    r.token,
                    'Shown once. Use it as "Authorization: Bearer <token>" against the server URL.',
                  ),
                );
            },
          },
          'Issue token',
        ),
        el(
          'button',
          {
            class: 'danger small',
            onclick: async () =>
              confirm(`Delete MCP server ${s.name}? Its tokens and OAuth grants stop working.`) &&
              (await guard(() => api('DELETE', `/v1/mcp-servers/${s.id}`), 'Deleted')) !== undefined &&
              route(),
          },
          'Delete',
        ),
      ),
    ]);
    v.append(
      el(
        'div',
        { class: 'head' },
        el(
          'div',
          {},
          el('h1', {}, 'MCP servers'),
          el(
            'div',
            { class: 'muted' },
            'Each server is one endpoint agents connect to. People sign in with OAuth at its URL, or you issue per-user tokens.',
          ),
        ),
      ),
      out,
      el('div', { class: 'card' }, table(['Server', 'Apps', 'Mode', ''], serverRows, 'No MCP servers yet.')),
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'New MCP server'),
        datalist,
        form(
          async (fd, f) => {
            const r = await guard(
              () =>
                api('POST', '/v1/mcp-servers', {
                  name: fd.get('name'),
                  toolkits: parseList(fd.get('toolkits')),
                  mode: fd.get('mode'),
                  connect_handoff: fd.get('handoff'),
                }),
              'Server created',
            );
            if (r) {
              f.reset();
              route();
            }
          },
          el(
            'div',
            { class: 'row' },
            field('Name', el('input', { name: 'name', required: true, placeholder: 'GitHub' })),
            field(
              'Apps (comma separated)',
              el('input', {
                name: 'toolkits',
                required: true,
                list: 'toolkit-list',
                placeholder: 'github, gmail',
              }),
            ),
            field(
              'Mode',
              el(
                'select',
                { name: 'mode' },
                el('option', { value: 'direct' }, 'direct — every tool listed (best for Paperclip)'),
                el('option', { value: 'router' }, 'router — search / execute meta tools'),
              ),
            ),
            field(
              'When an app is not connected',
              el(
                'select',
                { name: 'handoff' },
                el('option', { value: 'elicitation' }, 'elicitation — standard MCP sign-in prompt'),
                el('option', { value: 'text' }, 'text — link in the tool result'),
              ),
            ),
          ),
          el('button', { type: 'submit' }, 'Create server'),
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'OAuth grants'),
        table(
          ['User', 'Client', 'Server', 'Granted', 'Last used', ''],
          grants.items.map((g) => [
            g.user_id,
            g.client_name || '—',
            servers.items.find((s) => s.id === g.server_id)?.name || g.server_id,
            fmt(g.created_at),
            fmt(g.last_used_at),
            actions(
              el(
                'button',
                {
                  class: 'danger small',
                  onclick: async () =>
                    confirm(`Revoke ${g.client_name || 'this client'}'s access for ${g.user_id}?`) &&
                    (await guard(() => api('DELETE', `/v1/mcp-oauth-grants/${g.id}`), 'Revoked')) !==
                      undefined &&
                    route(),
                },
                'Revoke',
              ),
            ),
          ]),
          'Nobody has signed in through OAuth yet.',
        ),
      ),
    );
  },

  async triggers(v) {
    const [catalog, subs] = await Promise.all([
      api('GET', '/v1/triggers'),
      api('GET', '/v1/trigger-subscriptions'),
    ]);
    const out = el('div');
    const events = el('div');
    const showEvents = async (s) => {
      const r = await guard(() => api('GET', `/v1/trigger-subscriptions/${s.id}/events?limit=50`));
      if (r)
        events.replaceChildren(
          el(
            'div',
            { class: 'card' },
            el(
              'div',
              { class: 'head' },
              el('h2', {}, `Recent events · ${s.trigger}`),
              el('button', { class: 'ghost small', onclick: () => events.replaceChildren() }, 'Close'),
            ),
            table(
              ['Event', 'Status', 'Attempts', 'Error', 'Created', 'Delivered'],
              r.items.map((e) => [
                el('code', {}, e.id),
                status(e.status),
                e.attempts,
                e.last_error || '—',
                fmt(e.created_at),
                fmt(e.delivered_at),
              ]),
              'No events yet.',
            ),
          ),
        );
    };
    v.append(
      el(
        'div',
        { class: 'head' },
        el(
          'div',
          {},
          el('h1', {}, 'Triggers'),
          el(
            'div',
            { class: 'muted' },
            'App events (new email, new PR…) delivered to your webhook, signed with the subscription secret.',
          ),
        ),
      ),
      out,
      el(
        'div',
        { class: 'card' },
        table(
          ['Trigger', 'User', 'Webhook', 'Status', 'Last run', ''],
          subs.items.map((s) => [
            el('code', {}, s.trigger),
            s.user_id,
            el('code', {}, s.webhook_url),
            el(
              'div',
              {},
              status(s.status),
              s.last_error ? el('div', { class: 'error' }, s.last_error) : null,
            ),
            fmt(s.last_run_at),
            actions(
              el('button', { class: 'ghost small', onclick: () => showEvents(s) }, 'Events'),
              el(
                'button',
                {
                  class: 'danger small',
                  onclick: async () =>
                    confirm(`Delete subscription ${s.trigger} for ${s.user_id}?`) &&
                    (await guard(() => api('DELETE', `/v1/trigger-subscriptions/${s.id}`), 'Deleted')) !==
                      undefined &&
                    route(),
                },
                'Delete',
              ),
            ),
          ]),
          'No trigger subscriptions.',
        ),
      ),
      events,
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'New subscription'),
        form(
          async (fd, f) => {
            let config = {};
            try {
              config = fd.get('config') ? JSON.parse(fd.get('config')) : {};
            } catch {
              toast('Config must be valid JSON', true);
              return;
            }
            const r = await guard(
              () =>
                api('POST', '/v1/trigger-subscriptions', {
                  trigger: fd.get('trigger'),
                  user_id: fd.get('user_id'),
                  webhook_url: fd.get('webhook_url'),
                  config,
                }),
              'Subscribed',
            );
            if (r) {
              f.reset();
              await route();
              $('#view').prepend(
                secretBox(
                  'Signing secret',
                  r.signing_secret,
                  'Shown once. Verify X-Hub-Signature-256 = HMAC-SHA256(secret, "<X-Hub-Timestamp>.<body>").',
                ),
              );
            }
          },
          el(
            'div',
            { class: 'row' },
            field(
              'Trigger',
              el(
                'select',
                { name: 'trigger', required: true },
                catalog.items.map((t) =>
                  el('option', { value: t.slug }, `${t.toolkit} · ${t.name} (${t.strategy.toLowerCase()})`),
                ),
              ),
            ),
            field(
              'User',
              el('input', { name: 'user_id', required: true, placeholder: 'person@company.com' }),
            ),
            field(
              'Webhook URL',
              el('input', { name: 'webhook_url', type: 'url', required: true, placeholder: 'https://…' }),
            ),
          ),
          field(
            'Config (JSON, see GET /v1/triggers/<slug>)',
            el('textarea', {
              name: 'config',
              placeholder: '{"repository": {"owner": "acme", "repo": "api"}}',
            }),
          ),
          el('button', { type: 'submit' }, 'Subscribe'),
        ),
      ),
    );
  },

  async authConfigs(v) {
    const { items: providers } = await api('GET', '/v1/oauth-providers');
    const panel = el('div');
    const label = (p) =>
      p.source === 'tenant'
        ? el('span', { class: 'status-ACTIVE' }, 'Your app')
        : p.source === 'platform'
          ? el('span', { class: 'status-ACTIVE' }, 'Platform app')
          : el('span', { class: 'status-EXPIRED' }, 'Not set up');
    v.append(
      el(
        'div',
        { class: 'head' },
        el(
          'div',
          {},
          el('h1', {}, 'Sign-in setup'),
          el(
            'div',
            { class: 'muted' },
            'Set each provider up once. Everyone in this tenant then connects its apps by signing in, with no keys to paste.',
          ),
        ),
      ),
      panel,
      el(
        'div',
        { class: 'card' },
        table(
          ['Provider', 'Apps', 'Sign-in', ''],
          providers.map((p) => [
            el('strong', {}, p.name),
            p.toolkits.map((t) => el('span', { class: 'chip' }, t.name)),
            label(p),
            actions(
              el(
                'button',
                {
                  class: p.source === 'none' ? 'small' : 'ghost small',
                  onclick: () => {
                    panel.replaceChildren(
                      providerSetupCard(
                        p,
                        () => route(),
                        () => panel.replaceChildren(),
                      ),
                    );
                    panel.scrollIntoView({ behavior: 'smooth' });
                  },
                },
                p.source === 'none' ? 'Set up' : p.source === 'tenant' ? 'Change' : 'Use your own app',
              ),
              p.source === 'tenant'
                ? el(
                    'button',
                    {
                      class: 'danger small',
                      onclick: async () =>
                        confirm(
                          `Remove your ${p.name} app? Sign-in falls back to the platform app if there is one.`,
                        ) &&
                        (await guard(
                          () => api('DELETE', `/v1/oauth-providers/${encodeURIComponent(p.provider)}`),
                          'Removed',
                        )) !== undefined &&
                        route(),
                    },
                    'Remove',
                  )
                : null,
            ),
          ]),
          'No apps here use OAuth sign-in.',
        ),
      ),
    );
  },

  async settings(v) {
    const [sso, branding] = await Promise.all([
      api('GET', '/v1/settings/sso'),
      api('GET', '/v1/settings/branding'),
    ]);
    const preview = el('div', { class: 'preview' });
    const renderPreview = (b) => {
      preview.style.setProperty(
        '--accent',
        /^#[0-9a-fA-F]{6}$/.test(b.accent_color || '') ? b.accent_color : '',
      );
      preview.replaceChildren(
        ...[
          b.display_name || b.logo_url
            ? el(
                'div',
                { class: 'org' },
                b.logo_url && /^https:\/\//.test(b.logo_url) ? el('img', { src: b.logo_url, alt: '' }) : null,
                b.display_name || '',
              )
            : null,
          el('strong', {}, 'Connect GitHub'),
          el('div', { class: 'muted' }, 'This is how the hosted connect page header looks.'),
          el('button', { type: 'button' }, 'Continue to GitHub'),
          b.support_email ? el('div', { class: 'muted mt' }, `Questions? ${b.support_email}`) : null,
        ].filter(Boolean), // replaceChildren would turn null into the text "null"
      );
    };
    const brandForm = form(
      async (fd) => {
        const r = await guard(
          () =>
            api(
              'PUT',
              '/v1/settings/branding',
              Object.fromEntries(
                ['display_name', 'logo_url', 'accent_color', 'support_email'].map((k) => [
                  k,
                  fd.get(k) || undefined,
                ]),
              ),
            ),
          'Branding saved',
        );
        if (r) renderPreview(r);
      },
      el(
        'div',
        { class: 'row' },
        field(
          'Display name',
          el('input', { name: 'display_name', value: branding.display_name || '', maxlength: 80 }),
        ),
        field(
          'Logo URL (https)',
          el('input', { name: 'logo_url', value: branding.logo_url || '', type: 'url' }),
        ),
        field(
          'Accent colour',
          el('input', {
            name: 'accent_color',
            value: branding.accent_color || '',
            placeholder: '#3b5bdb',
            pattern: '#[0-9a-fA-F]{6}',
          }),
        ),
        field(
          'Support email',
          el('input', { name: 'support_email', value: branding.support_email || '', type: 'email' }),
        ),
      ),
      el('button', { type: 'submit' }, 'Save branding'),
    );
    brandForm.addEventListener('input', () => renderPreview(Object.fromEntries(new FormData(brandForm))));
    renderPreview(branding);
    v.append(
      el('div', { class: 'head' }, el('h1', {}, 'Settings')),
      el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Who can sign in with OAuth'),
        el(
          'p',
          { class: 'muted' },
          'People sign in through single sign-on before authorizing an MCP client. Only these domains or addresses may.',
        ),
        form(
          async (fd) => {
            await guard(
              () =>
                api('PUT', '/v1/settings/sso', {
                  allowed_domains: parseList(fd.get('domains')),
                  allowed_emails: parseList(fd.get('emails')),
                }),
              'Sign-in policy saved',
            );
          },
          el(
            'div',
            { class: 'row' },
            field(
              'Email domains',
              el('input', {
                name: 'domains',
                value: sso.allowed_domains.join(', '),
                placeholder: 'acme.com, acme.io',
              }),
            ),
            field(
              'Individual addresses',
              el('input', {
                name: 'emails',
                value: sso.allowed_emails.join(', '),
                placeholder: 'contractor@gmail.com',
              }),
            ),
          ),
          el('button', { type: 'submit' }, 'Save policy'),
        ),
      ),
      el('div', { class: 'card' }, el('h2', {}, 'Branding'), brandForm, preview),
    );
  },

  async audit(v) {
    const { items } = await api('GET', '/v1/audit-logs?limit=200');
    v.append(
      el(
        'div',
        { class: 'head' },
        el('div', {}, el('h1', {}, 'Audit log'), el('div', { class: 'muted' }, 'Latest 200 tool executions')),
      ),
      el(
        'div',
        { class: 'card' },
        table(
          ['Time', 'User', 'Tool', 'Result', 'Duration', 'Error'],
          items.map((a) => [
            fmt(a.created_at),
            a.user_id || '—',
            el('code', {}, a.tool || a.action),
            status(a.status === 'success' ? 'ACTIVE' : 'FAILED'),
            a.duration_ms != null ? `${a.duration_ms} ms` : '—',
            a.error || '',
          ]),
          'No tool calls yet.',
        ),
      ),
    );
  },
};

const NAV = [
  ['overview', 'Overview'],
  ['apps', 'Apps'],
  ['accounts', 'Connected accounts'],
  ['servers', 'MCP servers'],
  ['triggers', 'Triggers'],
  ['authConfigs', 'Sign-in setup'],
  ['settings', 'Settings'],
  ['audit', 'Audit log'],
];

async function route() {
  const name = (location.hash.slice(1) || 'overview').split('?')[0];
  const view = views[name] ? name : 'overview';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.dataset.view === view);
  const v = $('#view');
  v.replaceChildren(el('div', { class: 'muted' }, 'Loading…'));
  const frag = el('div');
  try {
    await views[view](frag);
    v.replaceChildren(...frag.childNodes);
  } catch (e) {
    if (e.message !== 'unauthorized')
      v.replaceChildren(el('div', { class: 'card error' }, `Could not load: ${e.message}`));
  }
}

function showLogin(message) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message || '';
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  route();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#nav').replaceChildren(...NAV.map(([id, label]) => el('a', { href: `#${id}`, 'data-view': id }, label)));
  window.addEventListener('hashchange', route);
  $('#logout').addEventListener('click', () => {
    setKey(null);
    showLogin();
  });
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const key = $('#api-key').value.trim();
    if (!/^chk_/.test(key)) return showLogin('That does not look like an API key (chk_…).');
    setKey(key);
    try {
      await api('GET', '/v1/usage');
      $('#api-key').value = '';
      showApp();
    } catch (e) {
      if (e.message !== 'unauthorized') showLogin(e.message);
    }
  });
  const back = new URLSearchParams(location.search);
  if (back.has('status')) {
    history.replaceState(null, '', location.pathname + location.hash);
    if (back.get('status') === 'success')
      setTimeout(() => toast('Connected. The hub keeps this connection for you.'), 300);
    else
      setTimeout(() => toast(back.get('error') || 'The connection did not complete. Try again.', true), 300);
  }
  if (memKey) showApp();
  else showLogin();
});
