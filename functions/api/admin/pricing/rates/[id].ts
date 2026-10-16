import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { exists, isoOrNull } from '../../../../_lib/crud';
import { pricingRateSchema } from '@shared/validation';
import { audited } from '../../../../_lib/audit';

// Admin: edit a base price. Bookings keep the price agreed when they were made.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, pricingRateSchema);
  if (input instanceof Response) return input;
  if (!(await exists(env, 'resources', input.resource_id))) return error('Resource not found', 400);
  const res = await audited(env, { actor: user, action: 'pricing.rate_updated', table: 'base_rates', id: String(params.id) }, () =>
    env.DB.prepare(
      `UPDATE base_rates SET resource_id = ?, pricing_model = ?, amount_pence = ?, effective_from = ?, effective_to = ?,
              is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    )
      .bind(
        input.resource_id, input.pricing_model,
        input.pricing_model === 'free' ? 0 : input.amount_pence,
        new Date(input.effective_from).toISOString(), isoOrNull(input.effective_to),
        input.is_active ? 1 : 0, now(), user.id, String(params.id),
      )
      .run());
  if (res.meta.changes !== 1) return error('Price not found', 404);
  return json({ ok: true });
};

// Admin: delete a base price (bookings keep their snapshot, so history is unaffected).
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  await audited(env, { actor: user, action: 'pricing.rate_deleted', table: 'base_rates', id: String(params.id) }, () =>
    env.DB.prepare('DELETE FROM base_rates WHERE id = ?').bind(String(params.id)).run());
  return json({ ok: true });
};
