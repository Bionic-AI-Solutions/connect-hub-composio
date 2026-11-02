/**
 * Outbound URL guard for tenant-supplied webhook targets. Stops a tenant from pointing deliveries at the cluster's
 * own network (metadata endpoints, internal services). Hostnames are checked when the URL is saved and every
 * resolved address is checked again right before each request, which also covers DNS that changes later.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from '../errors.js';

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.svc', '.cluster.local', '.home.arpa'];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((c) => inCidr(ip, c));
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

/** Validate a webhook URL when it is saved. */
export function assertPublicWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('webhook_url is not a valid URL');
  }
  if (u.username || u.password) throw badRequest('webhook_url must not contain credentials');
  if (allowPrivate) {
    if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('webhook_url must be http(s)');
    return u;
  }
  if (u.protocol !== 'https:') throw badRequest('webhook_url must use https');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw badRequest('webhook_url must be a public hostname');
  }
  if (isIP(host) && isPrivateAddress(host)) throw badRequest('webhook_url must not target a private address');
  return u;
}

/** Re-check right before connecting: every address the hostname resolves to must be public. */
export async function assertResolvesPublic(u: URL, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`webhook host ${host} resolves to a private address`);
  }
}
