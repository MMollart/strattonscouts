import { Miniflare } from 'miniflare';
import type { Env } from '../../functions/_lib/http';

// Every migration, applied in filename order exactly as wrangler applies them.
const MIGRATION_FILES = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const MIGRATIONS = Object.keys(MIGRATION_FILES)
  .sort()
  .map((k) => MIGRATION_FILES[k]);

/** Split a migration file into statements (no triggers or semicolons in strings). */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A real Cloudflare D1 database (workerd's SQLite via Miniflare) with the
 * project's migrations and seed data applied. Each call gets a fresh,
 * in-memory database.
 */
export async function createTestEnv(): Promise<{ env: Env; db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const sql of MIGRATIONS) {
    await db.batch(statements(sql).map((s) => db.prepare(s)));
  }
  const env = { DB: db, ENVIRONMENT: 'test', APP_BASE_URL: 'http://localhost' } as unknown as Env;
  return { env, db, dispose: () => mf.dispose() };
}

/** Insert a customer in the given pricing category. */
export async function addUser(db: D1Database, id: string, category = 'cat_scouts'): Promise<void> {
  const ts = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO users (id, email, full_name, phone_encrypted, password_hash, pricing_category_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
    )
    .bind(id, `${id}@example.com`, `User ${id}`, 'x', category, ts, ts)
    .run();
}

/** Give a user an administration role ('super_admin' | 'booking_admin' | 'viewer'). */
export async function addAdmin(db: D1Database, id: string, role: string): Promise<void> {
  await addUser(db, id);
  await db
    .prepare('INSERT INTO user_roles (user_id, role_id, granted_at, granted_by) SELECT ?, id, ?, NULL FROM roles WHERE name = ?')
    .bind(id, new Date().toISOString(), role)
    .run();
}
