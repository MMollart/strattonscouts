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
export async function createTestEnv(
  opts: { migratedPrices?: boolean; stopBefore?: string } = {},
): Promise<{ env: Env; db: D1Database; dispose: () => Promise<void>; applyRemaining: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  // stopBefore holds back that migration and later ones, so a test can shape
  // the data a migration will meet and then run the rest.
  const names = Object.keys(MIGRATION_FILES).sort();
  const cut = opts.stopBefore ? names.findIndex((n) => n.includes(opts.stopBefore!)) : -1;
  const now = cut === -1 ? MIGRATIONS : MIGRATIONS.slice(0, cut);
  const later = cut === -1 ? [] : MIGRATIONS.slice(cut);
  const apply = async (list: string[]) => {
    for (const sql of list) await db.batch(statements(sql).map((s) => db.prepare(s)));
  };
  await apply(now);
  if (!opts.migratedPrices && cut === -1) await applyTestPrices(db);
  const env = { DB: db, ENVIRONMENT: 'test', APP_BASE_URL: 'http://localhost' } as unknown as Env;
  return { env, db, dispose: () => mf.dispose(), applyRemaining: () => apply(later) };
}

/**
 * Round-number test prices: each resource's full (public) price is twice its
 * seeded Scouts price, Scouts get 50% off and Community 25% off, so Scouts pay
 * exactly the seeded Scouts prices (Main Hall £10/h, Small Hall £5/h, ...).
 * Pass { migratedPrices: true } to test the prices migration 0014 derives.
 */
async function applyTestPrices(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE base_rates SET amount_pence = 2 * (
      SELECT s.amount_pence FROM pricing_rates s
      WHERE s.resource_id = base_rates.resource_id AND s.category_id = 'cat_scouts' AND s.pricing_model = base_rates.pricing_model
      ORDER BY s.effective_from DESC LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM pricing_rates s WHERE s.resource_id = base_rates.resource_id AND s.category_id = 'cat_scouts')`),
    db.prepare("UPDATE pricing_categories SET discount_bp = CASE id WHEN 'cat_scouts' THEN 5000 WHEN 'cat_community' THEN 2500 ELSE 0 END"),
  ]);
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
