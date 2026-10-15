import { describe, it, expect } from 'vitest';
import { calculateTotalPence, billableHours, billableNights, formatGBP } from '@shared/pricing';

describe('pricing engine', () => {
  it('calculates hourly pricing rounding up to whole hours', () => {
    // 2.5 hours at £10/hr => 3 hours => £30
    expect(
      calculateTotalPence({
        pricingModel: 'hourly',
        unitPricePence: 1000,
        isFree: false,
        startsAt: '2026-01-01T10:00:00Z',
        endsAt: '2026-01-01T12:30:00Z',
      }),
    ).toBe(3000);
  });

  it('calculates nightly pricing rounding up to whole nights', () => {
    // 2 nights at £20 => £40
    expect(
      calculateTotalPence({
        pricingModel: 'nightly',
        unitPricePence: 2000,
        isFree: false,
        startsAt: '2026-01-01T12:00:00Z',
        endsAt: '2026-01-03T10:00:00Z',
      }),
    ).toBe(4000);
  });

  it('calculates fixed pricing irrespective of duration', () => {
    expect(
      calculateTotalPence({
        pricingModel: 'fixed',
        unitPricePence: 5000,
        isFree: false,
        startsAt: '2026-01-01T09:00:00Z',
        endsAt: '2026-01-01T23:00:00Z',
      }),
    ).toBe(5000);
  });

  it('supports zero-cost (free) bookings', () => {
    expect(
      calculateTotalPence({
        pricingModel: 'hourly',
        unitPricePence: 1000,
        isFree: true,
        startsAt: '2026-01-01T10:00:00Z',
        endsAt: '2026-01-01T12:00:00Z',
      }),
    ).toBe(0);
  });

  it('bills a minimum of one hour / one night', () => {
    expect(billableHours('2026-01-01T10:00:00Z', '2026-01-01T10:10:00Z')).toBe(1);
    expect(billableNights('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z')).toBe(1);
  });

  it('formats GBP from pence', () => {
    expect(formatGBP(1050)).toBe('£10.50');
    expect(formatGBP(0)).toBe('£0.00');
    expect(formatGBP(10000)).toBe('£100.00');
  });
});
