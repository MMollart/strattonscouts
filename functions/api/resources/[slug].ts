import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';

// Public: single resource detail by slug.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const slug = String(params.slug);
  const r = await env.DB.prepare(
    `SELECT id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at
     FROM resources WHERE slug = ?`,
  )
    .bind(slug)
    .first();
  if (!r) return error('Resource not found', 404);

  const prices = await env.DB.prepare(
    `SELECT pc.name AS category, pc.label, rp.amount_pence, rp.is_free
     FROM resource_pricing rp JOIN pricing_categories pc ON pc.id = rp.category_id WHERE rp.resource_id = ?`,
  )
    .bind(r.id)
    .all<{ category: string; label: string; amount_pence: number; is_free: number }>();

  const images = await env.DB.prepare(
    'SELECT id, r2_key, is_primary FROM resource_images WHERE resource_id = ? ORDER BY is_primary DESC',
  )
    .bind(r.id)
    .all<{ id: string; r2_key: string; is_primary: number }>();

  return json({
    ...r,
    is_active: !!(r.is_active as number),
    requires_approval: !!(r.requires_approval as number),
    prices: prices.results.map((p) => ({ ...p, is_free: !!p.is_free })),
    images: images.results.map((i) => ({ ...i, is_primary: !!i.is_primary })),
  });
};
