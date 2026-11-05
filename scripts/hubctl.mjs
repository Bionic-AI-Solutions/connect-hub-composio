#!/usr/bin/env node
/**
 * Small operator CLI over the hub's REST API.
 *
 *   HUB_URL=http://localhost:3000 ADMIN_TOKEN=… node scripts/hubctl.mjs tenant:create "Bionic AI"
 *   HUB_URL=… HUB_API_KEY=chk_… node scripts/hubctl.mjs server:create github-agents github,gmail [--router] [--elicitation]
 *   HUB_URL=… HUB_API_KEY=chk_… node scripts/hubctl.mjs token:issue <server_id> <user_id>
 *   HUB_URL=… HUB_API_KEY=chk_… node scripts/hubctl.mjs servers | accounts [user_id] | toolkits
 *   HUB_URL=… ADMIN_TOKEN=… node scripts/hubctl.mjs tenant:copy <from_tenant> <to_tenant> [--dry-run]
 *       [--toolkits=gmail,github] [--map=old@x.com=new@y.com,…]   copy OAuth apps + active accounts
 *
 * Secrets are printed once to stdout; nothing is written to disk.
 */
const [cmd, ...args] = process.argv.slice(2);
const base = (process.env.HUB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));

async function call(method, path, body, token) {
  if (!token) throw new Error(path.startsWith('/admin') ? 'Set ADMIN_TOKEN' : 'Set HUB_API_KEY');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error?.message ?? text}`);
  return data;
}
const admin = (m, p, b) => call(m, p, b, process.env.ADMIN_TOKEN);
const api = (m, p, b) => call(m, p, b, process.env.HUB_API_KEY);
const out = (v) => console.log(JSON.stringify(v, null, 2));

const commands = {
  'tenant:create': async () => out(await admin('POST', '/admin/tenants', { name: pos[0] ?? 'default' })),
  tenants: async () => out(await admin('GET', '/admin/tenants')),
  'tenant:copy': async () => {
    const usage =
      'usage: tenant:copy <from_tenant> <to_tenant> [--dry-run] [--toolkits=a,b] [--map=from_user=to_user,…]';
    if (pos.length !== 2) throw new Error(usage);
    // Strict flags: a mistyped --dry-run must not turn into a real copy.
    const body = { source_tenant_id: pos[0], dry_run: false };
    for (const a of args.filter((x) => x.startsWith('--'))) {
      const [name, value] = [
        a.slice(0, a.includes('=') ? a.indexOf('=') : a.length),
        a.slice(a.indexOf('=') + 1),
      ];
      if (a === '--dry-run') body.dry_run = true;
      else if (name === '--toolkits' && a.includes('=') && value.trim()) {
        body.toolkits = value.split(',').map((t) => t.trim());
        if (body.toolkits.some((t) => !t)) throw new Error(`empty toolkit in ${a}`);
      } else if (name === '--map' && a.includes('=') && value.trim()) {
        // user ids can contain ':' (agent:<id>), so each pair is from=to.
        body.user_map = Object.fromEntries(
          value.split(',').map((pair) => {
            const at = pair.indexOf('=');
            if (at <= 0 || at === pair.length - 1) throw new Error(`--map pair must be from=to: "${pair}"`);
            return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
          }),
        );
      } else throw new Error(`unknown or incomplete option ${a}\n${usage}`);
    }
    out(await admin('POST', `/admin/tenants/${encodeURIComponent(pos[1])}/copy-from`, body));
  },
  toolkits: async () => {
    const { items } = await api('GET', '/v1/toolkits');
    for (const t of items)
      console.log(
        `${t.slug.padEnd(24)} ${String(t.tool_count).padStart(4)} tools  ${t.auth_schemes.join(', ')}`,
      );
  },
  'server:create': async () => {
    if (!pos[0] || !pos[1])
      throw new Error('usage: server:create <name> <toolkit,toolkit…> [--router] [--elicitation]');
    out(
      await api('POST', '/v1/mcp-servers', {
        name: pos[0],
        toolkits: pos[1].split(','),
        mode: flags.has('--router') ? 'router' : 'direct',
        connect_handoff: flags.has('--elicitation') ? 'elicitation' : 'text',
      }),
    );
  },
  servers: async () => out(await api('GET', '/v1/mcp-servers')),
  'token:issue': async () => {
    if (!pos[0] || !pos[1]) throw new Error('usage: token:issue <server_id> <user_id>');
    out(await api('POST', `/v1/mcp-servers/${pos[0]}/tokens`, { user_id: pos[1] }));
  },
  'token:revoke': async () => out(await api('DELETE', `/v1/mcp-tokens/${pos[0]}`)),
  accounts: async () =>
    out(await api('GET', `/v1/connected-accounts${pos[0] ? `?user_id=${encodeURIComponent(pos[0])}` : ''}`)),
  link: async () => {
    if (!pos[0] || !pos[1]) throw new Error('usage: link <user_id> <toolkit>');
    out(await api('POST', '/v1/connected-accounts/link', { user_id: pos[0], toolkit: pos[1] }));
  },
};

if (!commands[cmd]) {
  console.error(`commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
commands[cmd]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
