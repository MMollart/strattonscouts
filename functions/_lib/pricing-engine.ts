import type { Env } from './http';
import { discountedAmount, computePrice, type DiscountRule, type OrganisationArrangement, type PriceBreakdown, type RateRule } from '@shared/pricing';
import { toArrangement, type OrganisationPricingRow } from './organisation-pricing';

export type QuoteResult =
  | { ok: true; categoryId: string; breakdown: PriceBreakdown }
  | { ok: false; code: 'no_price' | 'not_found'; message: string };

interface Dated {
  is_active: number;
  effective_from: string;
  effective_to: string | null;
  updated_at: string;
}

/**
 * Every pricing rule that could apply to one customer (or organisation) and
 * resource, loaded once so that many dates can be priced without a query each
 * (recurring series, FR05). Rules are filtered by effective date in
 * `quoteFromContext`.
 */
export interface PricingContext {
  categoryId: string;
  /** The price group's discount off the full (public) price, in basis points. */
  discountBp: number;
  rates: (RateRule & Dated)[];
  discounts: (DiscountRule & Dated)[];
  arrangements: (OrganisationPricingRow & { updated_at: string })[];
}

export async function loadPricingContext(
  env: Env,
  args: { resourceId: string; userId: string; organisationId?: string | null },
): Promise<PricingContext | null> {
  const holder = args.organisationId
    ? await env.DB.prepare('SELECT h.pricing_category_id, pc.discount_bp FROM organisations h JOIN pricing_categories pc ON pc.id = h.pricing_category_id WHERE h.id = ?')
        .bind(args.organisationId)
        .first<{ pricing_category_id: string; discount_bp: number }>()
    : await env.DB.prepare('SELECT h.pricing_category_id, pc.discount_bp FROM users h JOIN pricing_categories pc ON pc.id = h.pricing_category_id WHERE h.id = ?')
        .bind(args.userId)
        .first<{ pricing_category_id: string; discount_bp: number }>();
  if (!holder) return null;
  const categoryId = holder.pricing_category_id;

  const [rates, discounts, arrangements] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT id, pricing_model, amount_pence, is_active, effective_from, effective_to, updated_at FROM base_rates
       WHERE resource_id = ? AND is_active = 1`,
    ).bind(args.resourceId),
    env.DB.prepare(
      `SELECT id, name AS label, discount_type, value, is_active, effective_from, effective_to, updated_at FROM pricing_discounts
       WHERE (resource_id IS NULL OR resource_id = ?) AND (category_id IS NULL OR category_id = ?) AND is_active = 1`,
    ).bind(args.resourceId, categoryId),
    env.DB.prepare(
      `SELECT * FROM organisation_pricing
       WHERE organisation_id = ? AND is_active = 1 AND (resource_id = ? OR resource_id IS NULL)`,
    ).bind(args.organisationId ?? '', args.resourceId),
  ]);
  return {
    categoryId,
    discountBp: holder.discount_bp,
    rates: rates.results as unknown as PricingContext['rates'],
    discounts: discounts.results as unknown as PricingContext['discounts'],
    arrangements: args.organisationId ? (arrangements.results as unknown as PricingContext['arrangements']) : [],
  };
}

/** Rule rows effective at `at`: active, effective_from <= at < effective_to. */
const effectiveAt = (at: string) => (r: Dated) => !!r.is_active && r.effective_from <= at && (r.effective_to === null || r.effective_to > at);
const newestFirst = (a: Dated, b: Dated) => b.effective_from.localeCompare(a.effective_from) || b.updated_at.localeCompare(a.updated_at);

/**
 * The single organisation arrangement that applies at a time (FR14 §12.3): a
 * resource-specific rate or free use first, then a resource-specific discount,
 * then an all-resources discount; within each, the newest effective wins.
 */
function arrangementAt(rows: PricingContext['arrangements'], at: string): OrganisationArrangement | null {
  const rank = (r: OrganisationPricingRow) => (r.resource_id !== null && (r.arrangement_type === 'rate' || r.arrangement_type === 'free') ? 0 : r.resource_id !== null ? 1 : 2);
  const row = rows.filter(effectiveAt(at)).sort((a, b) => rank(a) - rank(b) || newestFirst(a, b))[0];
  return row ? toArrangement(row) : null;
}

/** Price one booking window from a loaded context. Effective dates are compared with the booking start. */
export function quoteFromContext(ctx: PricingContext, startsAt: string, endsAt: string): QuoteResult {
  const at = startsAt;
  const rate = ctx.rates.filter(effectiveAt(at)).sort(newestFirst)[0];
  const breakdown = computePrice({
    // The resource's base price, less the customer's price group discount.
    categoryRate: rate ? { id: rate.id, pricing_model: rate.pricing_model, amount_pence: discountedAmount(rate.amount_pence, ctx.discountBp) } : null,
    generalDiscounts: ctx.discounts.filter(effectiveAt(at)).map(({ id, label, discount_type, value }) => ({ id, label, discount_type, value })),
    arrangement: arrangementAt(ctx.arrangements, at),
    startsAt,
    endsAt,
  });
  if (!breakdown) return { ok: false, code: 'no_price', message: 'No price is configured for this resource and category' };
  return { ok: true, categoryId: ctx.categoryId, breakdown };
}

/**
 * Server-side price calculation (FR02 §3.4). Identifies the customer's (or
 * organisation's) price group, the base rate effective at the booking start
 * less that group's discount,
 * any organisation-specific arrangement and eligible discounts, and returns
 * the full breakdown.
 */
export async function quotePrice(
  env: Env,
  args: { resourceId: string; userId: string; organisationId?: string | null; startsAt: string; endsAt: string },
): Promise<QuoteResult> {
  const ctx = await loadPricingContext(env, args);
  if (!ctx) return { ok: false, code: 'not_found', message: args.organisationId ? 'Organisation not found' : 'Customer not found' };
  return quoteFromContext(ctx, args.startsAt, args.endsAt);
}
