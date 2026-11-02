#!/usr/bin/env node
/**
 * Add Activepieces integrations to the catalog.
 *   npm run catalog:add -- hubspot notion asana     # specific apps
 *   npm run catalog:add -- --all                    # every app piece on npm (~750; large install)
 * Restart the server afterwards; new toolkits are discovered automatically.
 */
import { execFileSync } from 'node:child_process';

// Engine/utility pieces that are not third-party apps.
const UTILITY = new Set([
  'http',
  'subflows',
  'webhook',
  'delay',
  'forms',
  'schedule',
  'store',
  'csv',
  'json',
  'xml',
  'tables',
  'queue',
  'tags',
  'date-helper',
  'text-helper',
  'file-helper',
  'flow-helper',
  'data-mapper',
  'crypto',
  'math-helper',
  'connections',
  'approval',
  'manual-trigger',
  'activepieces',
  'ai',
  'graphql',
  'sftp',
  'smtp',
  'imap',
  'pdf',
  'image-helper',
  'parallel',
]);

async function allPieces() {
  const names = new Set();
  for (let from = 0; from < 3000; from += 250) {
    const res = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=%40activepieces%2Fpiece-&size=250&from=${from}`,
    );
    const data = await res.json();
    for (const o of data.objects ?? [])
      if (o.package.name.startsWith('@activepieces/piece-'))
        names.add(o.package.name.slice('@activepieces/piece-'.length));
    if (!data.objects?.length) break;
  }
  return [...names].filter((n) => !UTILITY.has(n)).sort();
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: npm run catalog:add -- <app> [app…] | --all');
  process.exit(1);
}
const names = args.includes('--all') ? await allPieces() : args;
const bad = names.filter((n) => !/^[a-z0-9-]+$/.test(n));
if (bad.length) {
  console.error(`invalid piece name(s): ${bad.join(', ')}`);
  process.exit(1);
}
console.log(`Installing ${names.length} piece(s)…`);
execFileSync('npm', ['install', '--save', ...names.map((n) => `@activepieces/piece-${n}`)], {
  stdio: 'inherit',
});
