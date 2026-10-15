import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { exists, isoOrNull } from '../../../../_lib/crud';
import { discountSchema } from '@shared/validation';

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'finance.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    `SELECT d.*, r.name AS resource_name, pc.label AS category_label
     FROM pricing_discounts d LEFT JOIN resources r ON r.id = d.resource_id LEFT JOIN pricing_categories pc ON pc.id = d.category_id
     ORDER BY d.effective_from DESC`,
  ).all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, discountSchema);
  if (input instanceof Response) return input;
  if (input.resource_id && !(await exists(env, 'resources', input.resource_id))) return error('Resource not found', 400);
  if (input.category_id && !(await exists(env, 'pricing_categories', input.category_id))) return error('Category not found', 400);
  const id = newId('disc');
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO pricing_discounts (id, name, discount_type, value, resource_id, category_id, effective_from, effective_to, is_active, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, input.name, input.discount_type, input.value, input.resource_id ?? null, input.category_id ?? null,
      new Date(input.effective_from).toISOString(), isoOrNull(input.effective_to), input.is_active ? 1 : 0, ts, ts, user.id,
    )
    .run();
  return json({ id }, 201);
};
