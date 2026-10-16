import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { hashPassword, verifyPassword, encryptAtRest } from '../../_lib/crypto';
import { auditStatement } from '../../_lib/audit';

/**
 * Secure bootstrap for the initial Super Admin. Guarded by the
 * BOOTSTRAP_ADMIN_TOKEN secret and only works while no super admin exists.
 * This is NOT an open public registration flow.
 *
 * Body: { token, full_name, email, phone, password }
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  if (!env.BOOTSTRAP_ADMIN_TOKEN) {
    return error('Bootstrap is not configured', 403);
  }

  let body: { token?: string; full_name?: string; email?: string; phone?: string; password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error('Invalid JSON body');
  }

  if (body.token !== env.BOOTSTRAP_ADMIN_TOKEN) {
    return error('Invalid bootstrap token', 403);
  }

  // Only allowed while no super admin exists.
  const existingSuper = await env.DB.prepare(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super_admin' LIMIT 1`,
  ).first();
  if (existingSuper) return error('A Super Admin already exists', 409);

  if (!body.full_name || !body.email || !body.password || body.password.length < 10) {
    return error('full_name, email and a password (min 10 chars) are required', 400);
  }

  const email = body.email.toLowerCase();
  const ts = now();
  const cat = await env.DB.prepare("SELECT id FROM pricing_categories WHERE name = 'scouts'").first<{ id: string }>();
  const superRole = await env.DB.prepare("SELECT id FROM roles WHERE name = 'super_admin'").first<{ id: string }>();
  if (!cat || !superRole) return error('Database is not seeded', 500);

  let userId: string;
  const existingUser = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  if (existingUser) {
    // Promoting an existing account requires that account's own password.
    if (!(await verifyPassword(body.password, existingUser.password_hash))) {
      return error('Invalid credentials for the existing account', 403);
    }
    userId = existingUser.id;
  } else {
    userId = newId('usr');
    const passwordHash = await hashPassword(body.password);
    const phoneEncrypted = await encryptAtRest(body.phone ?? '', env.DATA_ENCRYPTION_KEY ?? '');
    await env.DB.prepare(
      'INSERT INTO users (id, email, full_name, phone_encrypted, password_hash, pricing_category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(userId, email, body.full_name, phoneEncrypted, passwordHash, cat.id, ts, ts)
      .run();
  }

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at, granted_by) VALUES (?, ?, ?, ?)').bind(userId, superRole.id, ts, userId),
    auditStatement(
      env,
      { actor: { id: userId, type: 'administrator' }, action: 'admin.bootstrapped', entityType: 'user', entityId: userId, after: { role: 'super_admin' } },
      { onlyIfChanged: true },
    ),
  ]);

  return json({ ok: true, user_id: userId }, 201);
};
