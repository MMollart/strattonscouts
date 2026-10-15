import type { Env } from './http';
import { discountedAmount, type RateModel } from '@shared/pricing';

export interface PublicPrice {
  category: string;
  label: string;
  pricing_model: RateModel;
  amount_pence: number;
  is_free: boolean;
}

/**
 * The price in force right now for each resource and active price group: the
 * resource's current base price (the latest effective one wins) less
 * the group's discount. Organisation arrangements and
 * discounts are not public; customers see them in their quote.
 */
export async function loadCurrentPrices(env: Env, resourceId?: string): Promise<(PublicPrice & { resource_id: string })[]> {
  const at = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT br.resource_id, pc.name AS category, pc.label, br.pricing_model, br.amount_pence, pc.discount_bp
     FROM base_rates br CROSS JOIN pricing_categories pc
     WHERE br.is_active = 1 AND pc.is_active = 1 AND br.effective_from <= ? AND (br.effective_to IS NULL OR br.effective_to > ?)
       ${resourceId ? 'AND br.resource_id = ?' : ''}
       AND br.id = (
         SELECT b2.id FROM base_rates b2
         WHERE b2.resource_id = br.resource_id AND b2.is_active = 1
           AND b2.effective_from <= ? AND (b2.effective_to IS NULL OR b2.effective_to > ?)
         ORDER BY b2.effective_from DESC, b2.updated_at DESC LIMIT 1)
     ORDER BY pc.sort_order`,
  )
    .bind(at, at, ...(resourceId ? [resourceId] : []), at, at)
    .all<{ resource_id: string; category: string; label: string; pricing_model: RateModel; amount_pence: number; discount_bp: number }>();
  return rows.results.map(({ discount_bp, ...r }) => {
    const free = r.pricing_model === 'free' || discount_bp >= 10_000;
    return { ...r, amount_pence: free ? 0 : discountedAmount(r.amount_pence, discount_bp), is_free: free };
  });
}
