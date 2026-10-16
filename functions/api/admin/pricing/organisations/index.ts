import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { exists, isoOrNull } from '../../../../_lib/crud';
import { findOverlappingArrangement } from '../../../../_lib/organisation-pricing';
import { organisationPricingSchema } from '@shared/validation';
import { audited } from '../../../../_lib/audit';

// Admin: organisation pricing arrangements, optionally for one organisation.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'finance.view');
  if (user instanceof Response) return user;
  const orgId = new URL(request.url).searchParams.get('organisation_id');
  const rows = await env.DB.prepare(
    `SELECT op.*, o.name AS organisation_name, r.name AS resource_name
     FROM organisation_pricing op JOIN organisations o ON o.id = op.organisation_id LEFT JOIN resources r ON r.id = op.resource_id
     ${orgId ? 'WHERE op.organisation_id = ?' : ''}
     ORDER BY o.name, r.name, op.effective_from DESC`,
  )
    .bind(...(orgId ? [orgId] : []))
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, organisationPricingSchema);
  if (input instanceof Response) return input;
  if (!(await exists(env, 'organisations', input.organisation_id))) return error('Organisation not found', 400);
  if (input.resource_id && !(await exists(env, 'resources', input.resource_id))) return error('Resource not found', 400);
  const from = new Date(input.effective_from).toISOString();
  const to = isoOrNull(input.effective_to);
  if (
    input.is_active &&
    (await findOverlappingArrangement(env, { organisationId: input.organisation_id, resourceId: input.resource_id ?? null, type: input.arrangement_type, from, to }))
  ) {
    return error('This organisation already has an arrangement for that resource during this period', 409, { code: 'overlap' });
  }
  const id = newId('orgp');
  const ts = now();
  await audited(env, { actor: user, action: 'pricing.organisation_arrangement_created', table: 'organisation_pricing', id }, () =>
    env.DB.prepare(
      `INSERT INTO organisation_pricing (id, organisation_id, resource_id, arrangement_type, pricing_model, value, effective_from, effective_to, is_active, notes, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, input.organisation_id, input.resource_id ?? null, input.arrangement_type,
        input.arrangement_type === 'rate' ? input.pricing_model : null,
        input.arrangement_type === 'free' ? 0 : input.value,
        from, to, input.is_active ? 1 : 0, input.notes ?? null, ts, ts, user.id,
      )
      .run());
  return json({ id }, 201);
};
