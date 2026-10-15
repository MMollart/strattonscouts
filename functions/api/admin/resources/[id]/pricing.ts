import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { getAuthUser, isAdmin } from '../../../../_lib/auth';
import { pricingUpsertSchema } from '@shared/validation';

// Admin: list pricing for a resource.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!isAdmin(user)) return error('Not authorised', 403);
  const resourceId = String(params.id);
  const rows = await env.DB.prepare(
    `SELECT rp.id, pc.id AS category_id, pc.name AS category, pc.label,
            COALESCE(rp.amount_pence, 0) AS amount_pence, COALESCE(rp.is_free, 0) AS is_free
     FROM pricing_categories pc
     LEFT JOIN resource_pricing rp ON rp.category_id = pc.id AND rp.resource_id = ?
     ORDER BY pc.sort_order`,
  )
    .bind(resourceId)
    .all();
  // Every category is listed so prices can be set for a new resource; `id` is
  // null where no price has been configured yet (customers cannot book it).
  return json(rows.results.map((r) => ({ ...r, is_free: !!(r.is_free as number) })));
};

// Admin: upsert pricing for a resource + category. Only affects future bookings.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!isAdmin(user)) return error('Not authorised', 403);
  const resourceId = String(params.id);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = pricingUpsertSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const ts = now();
  const existing = await env.DB.prepare(
    'SELECT id FROM resource_pricing WHERE resource_id = ? AND category_id = ?',
  )
    .bind(resourceId, parsed.data.category_id)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare('UPDATE resource_pricing SET amount_pence = ?, is_free = ?, updated_at = ? WHERE id = ?')
      .bind(parsed.data.amount_pence, parsed.data.is_free ? 1 : 0, ts, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      'INSERT INTO resource_pricing (id, resource_id, category_id, amount_pence, is_free, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(newId('pr'), resourceId, parsed.data.category_id, parsed.data.amount_pence, parsed.data.is_free ? 1 : 0, ts)
      .run();
  }

  return json({ ok: true });
};
