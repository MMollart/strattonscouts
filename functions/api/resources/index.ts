import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { loadCurrentPrices, type PublicPrice } from '../../_lib/public-prices';

// Public: list active resources with primary image key and category prices.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const resources = await env.DB.prepare(
    `SELECT id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, min_notice_minutes, max_advance_days, created_at, updated_at
     FROM resources WHERE is_active = 1 ORDER BY name`,
  ).all();

  const prices = await loadCurrentPrices(env);

  const images = await env.DB.prepare(
    'SELECT resource_id, r2_key FROM resource_images WHERE is_primary = 1',
  ).all<{ resource_id: string; r2_key: string }>();

  const priceMap: Record<string, PublicPrice[]> = {};
  for (const { resource_id, ...p } of prices) (priceMap[resource_id] ??= []).push(p);
  const imageMap: Record<string, string> = {};
  for (const i of images.results) imageMap[i.resource_id] = i.r2_key;

  const data = resources.results.map((r) => ({
    ...r,
    is_active: !!(r.is_active as number),
    requires_approval: !!(r.requires_approval as number),
    prices: priceMap[r.id as string] ?? [],
    primary_image_key: imageMap[r.id as string] ?? null,
  }));

  return json(data);
};
