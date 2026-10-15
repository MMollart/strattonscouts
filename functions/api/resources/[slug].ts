import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { loadCurrentPrices } from '../../_lib/public-prices';
import { loadRestrictions } from '../../_lib/restrictions';
import { provisionalHoldHours } from '../../_lib/provisional';
import { describeRule } from '@shared/availability-rules';

// Public: single resource detail by slug.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const slug = String(params.slug);
  const r = await env.DB.prepare(
    `SELECT id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, min_notice_minutes, max_advance_days, provisional_expiry_hours, created_at, updated_at
     FROM resources WHERE slug = ?`,
  )
    .bind(slug)
    .first();
  if (!r) return error('Resource not found', 404);

  const prices = await loadCurrentPrices(env, r.id as string);

  const images = await env.DB.prepare(
    'SELECT id, r2_key, is_primary FROM resource_images WHERE resource_id = ? ORDER BY is_primary DESC',
  )
    .bind(r.id)
    .all<{ id: string; r2_key: string; is_primary: number }>();

  const restrictions = await loadRestrictions(env, r.id as string);
  const holdHours = await provisionalHoldHours(env, r.provisional_expiry_hours as number | null);

  return json({
    ...r,
    availability_rules: restrictions.rules.map(describeRule),
    provisional_hold_hours: holdHours,
    is_active: !!(r.is_active as number),
    requires_approval: !!(r.requires_approval as number),
    prices: prices.map(({ resource_id: _r, ...p }) => p),
    images: images.results.map((i) => ({ ...i, is_primary: !!i.is_primary })),
  });
};
