import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { categoryCreateSchema } from '@shared/validation';
import { audited } from '../../../_lib/audit';

// Admin: rename, reorder, re-price (percentage adjustment) or retire a category. The internal name is fixed.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, categoryCreateSchema.omit({ name: true }));
  if (input instanceof Response) return input;
  const res = await audited(env, { actor: user, action: 'pricing.category_updated', table: 'pricing_categories', id: String(params.id) }, () =>
    env.DB.prepare('UPDATE pricing_categories SET label = ?, sort_order = ?, is_active = ?, discount_bp = ? WHERE id = ?')
      .bind(input.label, input.sort_order, input.is_active ? 1 : 0, input.discount_bp, String(params.id))
      .run());
  if (res.meta.changes !== 1) return error('Category not found', 404);
  return json({ ok: true });
};
