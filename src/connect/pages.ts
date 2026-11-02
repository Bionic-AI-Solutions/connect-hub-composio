import type { AuthScheme, Toolkit } from '../catalog/types.js';
import type { Branding } from '../tenancy/usage.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function layout(title: string, body: string, b: Branding = {}): string {
  // Accent and logo were validated when saved (hex colour, https URL); escaping still applies.
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accent_color ?? '') ? `:root{--accent:${b.accent_color}}` : '';
  const org =
    b.display_name || b.logo_url
      ? `<div class="org">${b.logo_url ? `<img src="${esc(b.logo_url)}" alt="">` : ''}${b.display_name ? `<span>${esc(b.display_name)}</span>` : ''}</div>`
      : '';
  const support = b.support_email
    ? `<p class="foot">Questions? <a href="mailto:${esc(b.support_email)}">${esc(b.support_email)}</a></p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171f;--muted:#5c6370;--line:#dde1e7;--accent:#3b5bdb;--err:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e8eaee;--muted:#9aa1ad;--line:#2a2f3a;--accent:#748ffc;--err:#ff8787}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;width:100%;max-width:440px}
.head{display:flex;gap:12px;align-items:center;margin-bottom:16px}.head img{width:40px;height:40px;border-radius:8px;object-fit:contain}
h1{font-size:19px;margin:0}p{color:var(--muted);margin:6px 0 16px}label{display:block;font-weight:600;margin:14px 0 4px}
small{display:block;color:var(--muted);margin-top:2px;font-size:13px}input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
button,.btn{display:block;width:100%;margin-top:20px;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.org{display:flex;gap:8px;align-items:center;margin-bottom:18px;color:var(--muted);font-size:13px;font-weight:600}.org img{height:24px;max-width:120px;object-fit:contain}
.foot{font-size:13px;margin:20px 0 0}.foot a{color:var(--accent)}
.err{color:var(--err)}.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.tabs a{font-size:13px;color:var(--accent)}
${accent}</style></head><body><main class="card">${org}${body}${support}</main></body></html>`;
}

function header(tk: Toolkit, subtitle: string) {
  return `<div class="head">${tk.logoUrl ? `<img src="${esc(tk.logoUrl)}" alt="">` : ''}<div><h1>Connect ${esc(tk.name)}</h1></div></div><p>${esc(subtitle)}</p>`;
}

export function connectPage(
  tk: Toolkit,
  scheme: AuthScheme,
  action: string,
  error?: string,
  branding: Branding = {},
): string {
  const fields = scheme.fields
    .map((f) => {
      const id = `f_${esc(f.name)}`;
      const help = f.description ? `<small>${esc(f.description)}</small>` : '';
      const req = f.required ? 'required' : '';
      let input: string;
      if (f.type === 'select') {
        input = `<select id="${id}" name="${esc(f.name)}" ${req}>${(f.options ?? []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'boolean') {
        input = `<input id="${id}" type="checkbox" name="${esc(f.name)}" value="true" style="width:auto">`;
      } else {
        const type = f.secret ? 'password' : f.type === 'number' ? 'number' : 'text';
        const value =
          !f.secret && f.defaultValue !== undefined && typeof f.defaultValue !== 'object'
            ? ` value="${esc(f.defaultValue)}"`
            : '';
        input = `<input id="${id}" type="${type}" name="${esc(f.name)}" autocomplete="off" ${req}${value}>`;
      }
      return `<label for="${id}">${esc(f.displayName)}${f.required ? '' : ' (optional)'}</label>${help}${input}`;
    })
    .join('');
  const subtitle =
    scheme.type === 'OAUTH2'
      ? `A few details are needed before you sign in to ${tk.name}.`
      : (scheme.description ??
        `Enter your ${tk.name} credentials. They are encrypted and only used to run actions you authorize.`);
  return layout(
    `Connect ${tk.name}`,
    `${header(tk, subtitle)}${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${esc(action)}">${fields}<button type="submit">${scheme.type === 'OAUTH2' ? `Continue to ${esc(tk.name)}` : 'Connect'}</button></form>`,
    branding,
  );
}

export function messagePage(
  title: string,
  message: string,
  isError = false,
  branding: Branding = {},
): string {
  return layout(
    title,
    `<h1>${esc(title)}</h1><p class="${isError ? 'err' : ''}">${esc(message)}</p>`,
    branding,
  );
}

export function consentPage(
  o: {
    clientName: string;
    redirectHost: string;
    email: string;
    serverName: string;
    requestId: string;
    consentToken: string;
  },
  branding: Branding = {},
): string {
  const hidden = (n: string, v: string) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;
  return layout(
    'Authorize access',
    `<h1>Authorize ${esc(o.clientName)}</h1>
<p><strong>${esc(o.clientName)}</strong> (${esc(o.redirectHost)}) wants to use the <strong>${esc(o.serverName)}</strong> tools
on your behalf, signed in as <strong>${esc(o.email)}</strong>. It will act with the app accounts you connect.</p>
<form method="post" action="/oauth2/consent">${hidden('request_id', o.requestId)}${hidden('consent_token', o.consentToken)}
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" style="background:transparent;color:var(--fg);border:1px solid var(--line)">Deny</button>
</form>`,
    branding,
  );
}
