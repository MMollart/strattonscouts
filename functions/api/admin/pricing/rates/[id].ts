import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { exists, isoOrNull } from '../../../../_lib/crud';
import { pricingRateSchema } from '@shared/validation';

// Admin: edit a rate. Bookings keep the price agreed when they were made.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, pricingRateSchema);
  if (input instanceof Response) return input;
  if (!(await exists(env, 'pricing_categories', input.category_id))) return error('Category not found', 400);
  const res = await env.DB.prepare(
    `UPDATE pricing_rates SET resource_id = ?, category_id = ?, pricing_model = ?, amount_pence = ?, effective_from = ?, effective_to = ?,
            is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
  )
    .bind(
      input.resource_id, input.category_id, input.pricing_model,
      input.pricing_model === 'free' ? 0 : input.amount_pence,
      new Date(input.effective_from).toISOString(), isoOrNull(input.effective_to),
      input.is_active ? 1 : 0, now(), user.id, String(params.id),
    )
    .run();
  if (res.meta.changes !== 1) return error('Rate not found', 404);
  return json({ ok: true });
};

// Admin: delete a rate (bookings keep their snapshot, so history is unaffected).
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  await env.DB.prepare('DELETE FROM pricing_rates WHERE id = ?').bind(String(params.id)).run();
  return json({ ok: true });
};
