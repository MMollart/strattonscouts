import type { Env } from './http';
import { computePrice, type DiscountRule, type OrganisationArrangement, type PriceBreakdown, type RateRule } from '@shared/pricing';
import { loadOrganisationArrangement } from './organisation-pricing';

/** Rule rows effective at `at`: active, effective_from <= at < effective_to. */
const EFFECTIVE_SQL = `is_active = 1 AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)`;

export type QuoteResult =
  | { ok: true; categoryId: string; breakdown: PriceBreakdown }
  | { ok: false; code: 'no_price' | 'not_found'; message: string };

/**
 * Server-side price calculation (FR02 §3.4). Identifies the customer's (or
 * organisation's) pricing category, the rate effective at the booking start,
 * any organisation-specific arrangement and eligible discounts, and returns
 * the full breakdown. Effective dates are compared with the booking start.
 */
export async function quotePrice(
  env: Env,
  args: { resourceId: string; userId: string; organisationId?: string | null; startsAt: string; endsAt: string },
): Promise<QuoteResult> {
  const holder = args.organisationId
    ? await env.DB.prepare('SELECT pricing_category_id FROM organisations WHERE id = ?').bind(args.organisationId).first<{ pricing_category_id: string }>()
    : await env.DB.prepare('SELECT pricing_category_id FROM users WHERE id = ?').bind(args.userId).first<{ pricing_category_id: string }>();
  if (!holder) return { ok: false, code: 'not_found', message: args.organisationId ? 'Organisation not found' : 'Customer not found' };
  const categoryId = holder.pricing_category_id;
  const at = args.startsAt;

  const [rates, discounts] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT id, pricing_model, amount_pence FROM pricing_rates
       WHERE resource_id = ? AND category_id = ? AND ${EFFECTIVE_SQL}
       ORDER BY effective_from DESC, updated_at DESC LIMIT 1`,
    ).bind(args.resourceId, categoryId, at, at),
    env.DB.prepare(
      `SELECT id, name AS label, discount_type, value FROM pricing_discounts
       WHERE (resource_id IS NULL OR resource_id = ?) AND (category_id IS NULL OR category_id = ?) AND ${EFFECTIVE_SQL}`,
    ).bind(args.resourceId, categoryId, at, at),
  ]);

  const arrangement: OrganisationArrangement | null = args.organisationId
    ? await loadOrganisationArrangement(env, { organisationId: args.organisationId, resourceId: args.resourceId, at })
    : null;

  const breakdown = computePrice({
    categoryRate: (rates.results[0] as unknown as RateRule | undefined) ?? null,
    generalDiscounts: discounts.results as unknown as DiscountRule[],
    arrangement,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
  });
  if (!breakdown) return { ok: false, code: 'no_price', message: 'No price is configured for this resource and category' };
  return { ok: true, categoryId, breakdown };
}
