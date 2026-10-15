import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { getAuthUser, isAdmin, isSuperAdmin } from '../../../_lib/auth';
import { adminUserUpdateSchema } from '@shared/validation';

// Admin: correct a customer's category (admin) or grant/revoke roles (super admin).
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const actor = await getAuthUser(env, request);
  if (!isAdmin(actor)) return error('Not authorised', 403);
  const userId = String(params.id);

  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) return error('User not found', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = adminUserUpdateSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  // Category correction — any admin.
  if (parsed.data.pricing_category_id) {
    const cat = await env.DB.prepare('SELECT id FROM pricing_categories WHERE id = ?')
      .bind(parsed.data.pricing_category_id)
      .first();
    if (!cat) return error('Invalid category', 400);
    await env.DB.prepare('UPDATE users SET pricing_category_id = ?, updated_at = ? WHERE id = ?')
      .bind(parsed.data.pricing_category_id, now(), userId)
      .run();
  }

  // Role changes — super admin only.
  if (parsed.data.grant_role || parsed.data.revoke_role) {
    if (!isSuperAdmin(actor)) return error('Only a Super Admin can manage administrators', 403);

    if (parsed.data.grant_role) {
      const role = await env.DB.prepare('SELECT id FROM roles WHERE name = ?').bind(parsed.data.grant_role).first<{ id: string }>();
      if (!role) return error('Invalid role', 400);
      await env.DB.prepare(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at, granted_by) VALUES (?, ?, ?, ?)',
      )
        .bind(userId, role.id, now(), actor!.id)
        .run();
    }
    if (parsed.data.revoke_role) {
      const role = await env.DB.prepare('SELECT id FROM roles WHERE name = ?').bind(parsed.data.revoke_role).first<{ id: string }>();
      if (role) {
        // Never remove the last Super Admin: the guard is part of the DELETE so
        // two simultaneous revocations cannot both succeed.
        const removed = await env.DB.prepare(
          `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?
           AND (? <> 'super_admin' OR (SELECT COUNT(*) FROM user_roles WHERE role_id = ?) > 1)`,
        )
          .bind(userId, role.id, parsed.data.revoke_role, role.id)
          .run();
        if (removed.meta.changes === 0 && parsed.data.revoke_role === 'super_admin') {
          const has = await env.DB.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?')
            .bind(userId, role.id)
            .first();
          if (has) return error('There must always be at least one Super Admin', 409);
        }
      }
    }
  }

  return json({ ok: true });
};
