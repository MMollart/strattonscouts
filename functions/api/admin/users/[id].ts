import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { adminUserUpdateSchema } from '@shared/validation';

// Admin: correct a customer's pricing category. Administrator roles are
// managed separately at /api/admin/admins/:id (Super Admins only).
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const actor = await requirePermission(env, request, 'bookings.manage');
  if (actor instanceof Response) return actor;
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

  const cat = await env.DB.prepare('SELECT id FROM pricing_categories WHERE id = ?')
    .bind(parsed.data.pricing_category_id)
    .first();
  if (!cat) return error('Invalid category', 400);
  await env.DB.prepare('UPDATE users SET pricing_category_id = ?, updated_at = ? WHERE id = ?')
    .bind(parsed.data.pricing_category_id, now(), userId)
    .run();

  return json({ ok: true });
};
