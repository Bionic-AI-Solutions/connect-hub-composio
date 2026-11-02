import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('dashboard', () => {
  it('serves the static dashboard with a strict content security policy', async () => {
    ctx = await setup();
    for (const [path, type] of [
      ['/dashboard', 'text/html'],
      ['/dashboard/app.js', 'text/javascript'],
      ['/dashboard/app.css', 'text/css'],
    ]) {
      const r = await ctx.app.inject({ method: 'GET', url: path });
      expect(r.statusCode, path).toBe(200);
      expect(r.headers['content-type']).toContain(type);
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).toContain("frame-ancestors 'none'");
    }
    const html = (await ctx.app.inject({ method: 'GET', url: '/dashboard' })).body;
    expect(html).not.toMatch(/<script>|style="/);
    const js = (await ctx.app.inject({ method: 'GET', url: '/dashboard/app.js' })).body;
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
