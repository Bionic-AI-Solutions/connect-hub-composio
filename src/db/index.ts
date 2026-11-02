import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** Postgres in production; PGlite (Postgres compiled to WASM) for local dev and tests — same SQL either way. */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const target = url.slice('pglite:'.length);
    if (target !== 'memory') mkdirSync(target, { recursive: true });
    const pg = target === 'memory' ? new PGlite() : new PGlite(target);
    return {
      query: async (sql, params) => ({ rows: (await pg.query(sql, params as any[])).rows as any[] }),
      close: () => pg.close(),
    };
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    query: async (sql, params) => ({ rows: (await pool.query(sql, params as any[])).rows }),
    close: () => pool.end(),
  };
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db): Promise<void> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const stmt of sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.query(stmt);
    }
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}
