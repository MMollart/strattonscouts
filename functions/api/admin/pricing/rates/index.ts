import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { exists, isoOrNull } from '../../../../_lib/crud';
import { pricingRateSchema } from '@shared/validation';

// Admin: list rates, optionally for one resource.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'finance.view');
  if (user instanceof Response) return user;
  const resourceId = new URL(request.url).searchParams.get('resource_id');
  const rows = await env.DB.prepare(
    `SELECT pr.id, pr.resource_id, pr.category_id, pc.label AS category_label, pr.pricing_model, pr.amount_pence,
            pr.effective_from, pr.effective_to, pr.is_active, pr.updated_at
     FROM pricing_rates pr JOIN pricing_categories pc ON pc.id = pr.category_id
     ${resourceId ? 'WHERE pr.resource_id = ?' : ''}
     ORDER BY pr.resource_id, pc.sort_order, pr.effective_from DESC`,
  )
    .bind(...(resourceId ? [resourceId] : []))
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

// Admin: add a rate. New rates affect bookings priced from now on only.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, pricingRateSchema);
  if (input instanceof Response) return input;
  if (!(await exists(env, 'resources', input.resource_id))) return error('Resource not found', 400);
  if (!(await exists(env, 'pricing_categories', input.category_id))) return error('Category not found', 400);
  const id = newId('rate');
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO pricing_rates (id, resource_id, category_id, pricing_model, amount_pence, effective_from, effective_to, is_active, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, input.resource_id, input.category_id, input.pricing_model,
      input.pricing_model === 'free' ? 0 : input.amount_pence,
      new Date(input.effective_from).toISOString(), isoOrNull(input.effective_to),
      input.is_active ? 1 : 0, ts, ts, user.id,
    )
    .run();
  return json({ id }, 201);
};
