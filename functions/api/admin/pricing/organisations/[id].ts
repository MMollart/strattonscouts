import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { isoOrNull } from '../../../../_lib/crud';
import { findOverlappingArrangement } from '../../../../_lib/organisation-pricing';
import { organisationPricingSchema } from '@shared/validation';
import { audited } from '../../../../_lib/audit';

// Admin: edit, disable or re-enable an arrangement. Bookings keep their agreed price.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, organisationPricingSchema);
  if (input instanceof Response) return input;
  const id = String(params.id);
  const from = new Date(input.effective_from).toISOString();
  const to = isoOrNull(input.effective_to);
  if (
    input.is_active &&
    (await findOverlappingArrangement(env, { organisationId: input.organisation_id, resourceId: input.resource_id ?? null, type: input.arrangement_type, from, to, excludeId: id }))
  ) {
    return error('This organisation already has an arrangement for that resource during this period', 409, { code: 'overlap' });
  }
  const res = await audited(env, { actor: user, action: 'pricing.organisation_arrangement_updated', table: 'organisation_pricing', id }, () =>
    env.DB.prepare(
      `UPDATE organisation_pricing SET resource_id = ?, arrangement_type = ?, pricing_model = ?, value = ?, effective_from = ?, effective_to = ?,
              is_active = ?, notes = ?, updated_at = ?, updated_by = ?
       WHERE id = ? AND organisation_id = ?`,
    )
      .bind(
        input.resource_id ?? null, input.arrangement_type, input.arrangement_type === 'rate' ? input.pricing_model : null,
        input.arrangement_type === 'free' ? 0 : input.value, from, to, input.is_active ? 1 : 0, input.notes ?? null, now(), user.id,
        id, input.organisation_id,
      )
      .run());
  if (res.meta.changes !== 1) return error('Arrangement not found', 404);
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  await audited(env, { actor: user, action: 'pricing.organisation_arrangement_deleted', table: 'organisation_pricing', id: String(params.id) }, () =>
    env.DB.prepare('DELETE FROM organisation_pricing WHERE id = ?').bind(String(params.id)).run());
  return json({ ok: true });
};
