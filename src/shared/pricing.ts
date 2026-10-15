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
