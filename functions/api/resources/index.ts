import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';

// Public: list active resources with primary image key and category prices.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const resources = await env.DB.prepare(
    `SELECT id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at
     FROM resources WHERE is_active = 1 ORDER BY name`,
  ).all();

  const prices = await env.DB.prepare(
    `SELECT rp.resource_id, pc.name AS category, rp.amount_pence, rp.is_free
     FROM resource_pricing rp JOIN pricing_categories pc ON pc.id = rp.category_id`,
  ).all<{ resource_id: string; category: string; amount_pence: number; is_free: number }>();

  const images = await env.DB.prepare(
    'SELECT resource_id, r2_key FROM resource_images WHERE is_primary = 1',
  ).all<{ resource_id: string; r2_key: string }>();

  const priceMap: Record<string, { category: string; amount_pence: number; is_free: boolean }[]> = {};
  for (const p of prices.results) {
    (priceMap[p.resource_id] ??= []).push({ category: p.category, amount_pence: p.amount_pence, is_free: !!p.is_free });
  }
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
