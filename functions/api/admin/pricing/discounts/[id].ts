import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { isoOrNull } from '../../../../_lib/crud';
import { discountSchema } from '@shared/validation';

export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, discountSchema);
  if (input instanceof Response) return input;
  const res = await env.DB.prepare(
    `UPDATE pricing_discounts SET name = ?, discount_type = ?, value = ?, resource_id = ?, category_id = ?, effective_from = ?, effective_to = ?,
            is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
  )
    .bind(
      input.name, input.discount_type, input.value, input.resource_id ?? null, input.category_id ?? null,
      new Date(input.effective_from).toISOString(), isoOrNull(input.effective_to), input.is_active ? 1 : 0, now(), user.id, String(params.id),
    )
    .run();
  if (res.meta.changes !== 1) return error('Discount not found', 404);
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  await env.DB.prepare('DELETE FROM pricing_discounts WHERE id = ?').bind(String(params.id)).run();
  return json({ ok: true });
};
