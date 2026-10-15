import type { Env } from '../../../_lib/http';
import { error, json, newId } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { categoryCreateSchema } from '@shared/validation';

// Admin: all categories, including retired ones.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare('SELECT id, name, label, sort_order, is_active, price_adjustment_bp FROM pricing_categories ORDER BY sort_order').all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

// Admin: add a customer pricing category.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'pricing.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, categoryCreateSchema);
  if (input instanceof Response) return input;
  const clash = await env.DB.prepare('SELECT 1 FROM pricing_categories WHERE name = ?').bind(input.name).first();
  if (clash) return error('A category with this name already exists', 409);
  const id = newId('cat');
  await env.DB.prepare('INSERT INTO pricing_categories (id, name, label, sort_order, is_active, price_adjustment_bp) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, input.name, input.label, input.sort_order, input.is_active ? 1 : 0, input.price_adjustment_bp)
    .run();
  return json({ id }, 201);
};
