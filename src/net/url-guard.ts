/**
 * Outbound URL guard for tenant-supplied webhook targets. Stops a tenant from pointing deliveries at the cluster's
 * own network (metadata endpoints, internal services). URLs are checked when saved and again on every send, and
 * the connection goes through a lookup that validates the exact address the socket connects to.
 */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
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
    // ULA, link-local, multicast; plus NAT64 (64:ff9b::/96) and 6to4 (2002::/16), which can embed any IPv4 address.
    return /^(fc|fd|fe8|fe9|fea|feb|ff|64:ff9b:|2002:)/.test(v);
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
  // A trailing dot is the same host ("metadata.google.internal." == "metadata.google.internal").
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw badRequest('webhook_url must be a public hostname');
  }
  if (isIP(host) && isPrivateAddress(host)) throw badRequest('webhook_url must not target a private address');
  return u;
}

/**
 * DNS lookup for outbound webhook connections that refuses private addresses. Because the socket connects to the
 * address this function returns, there is no gap between the check and the connection (unlike a separate lookup
 * followed by fetch, which resolves again and can be rebound).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: any, callback: (...args: any[]) => void) => {
    lookup(hostname, { all: true, family: options?.family ?? 0 })
      .then((addrs) => {
        if (!addrs.length)
          throw Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' });
        if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
          throw Object.assign(new Error(`webhook host ${hostname} resolves to a private address`), {
            code: 'EPRIVATE',
          });
        }
        if (options?.all) callback(null, addrs);
        else callback(null, addrs[0].address, addrs[0].family);
      })
      .catch((e) => callback(e));
  };
}

/** POST a JSON body to a tenant webhook. Returns the HTTP status; never follows redirects. */
export function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  allowPrivate: boolean,
  timeoutMs = 10_000,
): Promise<number> {
  const u = assertPublicWebhookUrl(rawUrl, allowPrivate);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
        lookup: guardedLookup(allowPrivate) as any,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        res.resume(); // discard the body
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      },
    );
    // Total deadline, not just idle time: a receiver trickling bytes cannot hold the delivery (and its lease) open.
    const deadline = setTimeout(
      () => req.destroy(new Error(`receiver did not answer within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error(`receiver did not answer within ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(body);
  });
}
