import type { Env } from './http';
import type { RateModel } from '@shared/pricing';

export interface PublicPrice {
  category: string;
  label: string;
  pricing_model: RateModel;
  amount_pence: number;
  is_free: boolean;
}

/**
 * The standard category rate in force right now for each resource and active
 * category (the latest effective rate wins). Organisation arrangements and
 * discounts are not public; customers see them in their quote.
 */
export async function loadCurrentPrices(env: Env, resourceId?: string): Promise<(PublicPrice & { resource_id: string })[]> {
  const at = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT pr.resource_id, pc.name AS category, pc.label, pr.pricing_model, pr.amount_pence
     FROM pricing_rates pr JOIN pricing_categories pc ON pc.id = pr.category_id
     WHERE pr.is_active = 1 AND pc.is_active = 1 AND pr.effective_from <= ? AND (pr.effective_to IS NULL OR pr.effective_to > ?)
       ${resourceId ? 'AND pr.resource_id = ?' : ''}
       AND pr.id = (
         SELECT p2.id FROM pricing_rates p2
         WHERE p2.resource_id = pr.resource_id AND p2.category_id = pr.category_id AND p2.is_active = 1
           AND p2.effective_from <= ? AND (p2.effective_to IS NULL OR p2.effective_to > ?)
         ORDER BY p2.effective_from DESC, p2.updated_at DESC LIMIT 1)
     ORDER BY pc.sort_order`,
  )
    .bind(at, at, ...(resourceId ? [resourceId] : []), at, at)
    .all<{ resource_id: string; category: string; label: string; pricing_model: RateModel; amount_pence: number }>();
  return rows.results.map((r) => ({ ...r, is_free: r.pricing_model === 'free' }));
}
