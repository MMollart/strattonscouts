import type { PricingModel } from './types';

export const MS_PER_HOUR = 1000 * 60 * 60;
export const MS_PER_DAY = MS_PER_HOUR * 24;

/** Two half-open intervals [aStart,aEnd) and [bStart,bEnd) overlap. */
export function intervalsOverlap(
  aStart: string | number | Date,
  aEnd: string | number | Date,
  bStart: string | number | Date,
  bEnd: string | number | Date,
): boolean {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  return as < be && bs < ae;
}

/** Number of whole hours, rounded up, between two instants (min 1). */
export function billableHours(startsAt: string, endsAt: string): number {
  const ms = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  return Math.max(1, Math.ceil(ms / MS_PER_HOUR));
}

const londonDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Days since the epoch of the UK calendar date an instant falls on. */
function londonDayNumber(instant: string): number {
  return Date.parse(`${londonDate.format(new Date(instant))}T00:00:00Z`) / MS_PER_DAY;
}

/**
 * Number of nights a stay covers: the number of UK calendar dates crossed
 * between arrival and departure, so Friday 14:00 to Sunday 16:00 is two
 * nights whatever the arrival and departure times (min 1).
 */
export function billableNights(startsAt: string, endsAt: string): number {
  return Math.max(1, londonDayNumber(endsAt) - londonDayNumber(startsAt));
}

/**
 * Calculate the total price in pence for a booking.
 * All monetary arithmetic uses integer minor units.
 */
export function calculateTotalPence(params: {
  pricingModel: PricingModel;
  unitPricePence: number;
  isFree: boolean;
  startsAt: string;
  endsAt: string;
}): number {
  if (params.isFree) return 0;
  const unit = Math.max(0, Math.trunc(params.unitPricePence));
  switch (params.pricingModel) {
    case 'hourly':
      return unit * billableHours(params.startsAt, params.endsAt);
    case 'nightly':
      return unit * billableNights(params.startsAt, params.endsAt);
    case 'fixed':
      return unit;
    default:
      return unit;
  }
}

/** Format pence as a GBP string, e.g. 1050 -> "£10.50". */
export function formatGBP(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return `${sign}£${(abs / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Release 2 pricing engine (FR02 / FR14). Pure: the API loads the applicable
// rules and calls computePrice; the result is stored on the booking.
// ---------------------------------------------------------------------------

export type RateModel = PricingModel | 'free';

export interface RateRule {
  id: string;
  pricing_model: RateModel;
  amount_pence: number;
}

export interface DiscountRule {
  id: string;
  label: string;
  discount_type: 'percentage' | 'fixed';
  /** Basis points for percentage (2000 = 20%), pence for fixed. */
  value: number;
}

/** An organisation-specific arrangement that applies to this booking (FR14). */
export type OrganisationArrangement =
  | { id: string; kind: 'rate'; label: string; rate: RateRule }
  | { id: string; kind: 'free'; label: string }
  | { id: string; kind: 'discount'; label: string; discount: DiscountRule };

export type PriceSource = 'category_rate' | 'organisation_rate' | 'organisation_free' | 'organisation_discount';

export interface PriceBreakdown {
  pricing_model: RateModel;
  unit_price_pence: number;
  quantity: number;
  quantity_unit: 'hour' | 'night' | 'booking';
  base_amount_pence: number;
  discount_pence: number;
  discount_label: string | null;
  total_pence: number;
  source: PriceSource;
  pricing_rate_id: string | null;
  pricing_discount_id: string | null;
  organisation_pricing_id: string | null;
}

/** Billable quantity for a pricing model. */
export function billableQuantity(model: RateModel, startsAt: string, endsAt: string): { quantity: number; unit: PriceBreakdown['quantity_unit'] } {
  if (model === 'hourly') return { quantity: billableHours(startsAt, endsAt), unit: 'hour' };
  if (model === 'nightly') return { quantity: billableNights(startsAt, endsAt), unit: 'night' };
  return { quantity: 1, unit: 'booking' };
}

/** Discount in pence for a base amount; never more than the base. */
export function discountAmount(basePence: number, discount: DiscountRule): number {
  const base = Math.max(0, Math.trunc(basePence));
  const raw = discount.discount_type === 'percentage'
    ? Math.round((base * Math.min(10_000, Math.max(0, discount.value))) / 10_000)
    : Math.max(0, Math.trunc(discount.value));
  return Math.min(base, raw);
}

/**
 * Price a booking. Precedence (FR14 §12.3):
 *  1. an organisation-specific rate (or free use) replaces the category rate;
 *  2. otherwise an organisation-specific discount applies to the category rate;
 *  3. otherwise the category rate, with the best eligible general discount.
 * Only one discount ever applies, so arrangements never stack.
 */
export function computePrice(params: {
  categoryRate: RateRule | null;
  generalDiscounts: DiscountRule[];
  arrangement: OrganisationArrangement | null;
  startsAt: string;
  endsAt: string;
}): PriceBreakdown | null {
  const { arrangement, startsAt, endsAt } = params;

  const priced = (rate: RateRule, source: PriceSource, orgId: string | null): PriceBreakdown => {
    const free = rate.pricing_model === 'free';
    const unit = free ? 0 : Math.max(0, Math.trunc(rate.amount_pence));
    const { quantity, unit: quantityUnit } = billableQuantity(rate.pricing_model, startsAt, endsAt);
    const base = unit * quantity;
    return {
      pricing_model: rate.pricing_model,
      unit_price_pence: unit,
      quantity,
      quantity_unit: quantityUnit,
      base_amount_pence: base,
      discount_pence: 0,
      discount_label: null,
      total_pence: base,
      source,
      pricing_rate_id: source === 'category_rate' ? rate.id : null,
      pricing_discount_id: null,
      organisation_pricing_id: orgId,
    };
  };

  const withDiscount = (b: PriceBreakdown, d: DiscountRule, orgId: string | null): PriceBreakdown => {
    const off = discountAmount(b.base_amount_pence, d);
    return {
      ...b,
      discount_pence: off,
      discount_label: d.label,
      total_pence: b.base_amount_pence - off,
      pricing_discount_id: orgId ? null : d.id,
      organisation_pricing_id: orgId,
      source: orgId ? 'organisation_discount' : b.source,
    };
  };

  if (arrangement?.kind === 'rate') return priced(arrangement.rate, 'organisation_rate', arrangement.id);
  if (arrangement?.kind === 'free') {
    return priced({ id: arrangement.id, pricing_model: 'free', amount_pence: 0 }, 'organisation_free', arrangement.id);
  }
  if (!params.categoryRate) return null;
  const base = priced(params.categoryRate, 'category_rate', null);
  if (arrangement?.kind === 'discount') {
    return { ...withDiscount(base, arrangement.discount, arrangement.id), pricing_rate_id: base.pricing_rate_id };
  }
  let best: PriceBreakdown = base;
  for (const d of params.generalDiscounts) {
    const candidate = withDiscount(base, d, null);
    if (candidate.discount_pence > best.discount_pence) best = candidate;
  }
  return best;
}

export const RATE_MODEL_LABEL: Record<RateModel, string> = {
  hourly: 'per hour',
  nightly: 'per night',
  fixed: 'per booking',
  free: 'free',
};

/** Basis points as a percentage string, e.g. 2000 -> "20%", 1250 -> "12.5%". */
export function formatPercent(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** A price group's price: the resource's base (public) price less the group's discount, to the nearest penny. */
export function discountedAmount(basePence: number, discountBp: number): number {
  const off = Math.min(10_000, Math.max(0, Math.trunc(discountBp)));
  return Math.round((Math.max(0, Math.trunc(basePence)) * (10_000 - off)) / 10_000);
}

/** "Full price", "25% off" or "Free" for a group's discount. */
export function describeDiscount(discountBp: number): string {
  if (discountBp <= 0) return 'Full price';
  if (discountBp >= 10_000) return 'Free';
  const pct = discountBp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}% off`;
}
