import { describe, it, expect } from 'vitest';
import { addDays, fromLondon, toLondon, weekdayMondayFirst } from '@shared/londonTime';

describe('UK local time helpers', () => {
  it('converts BST and GMT wall-clock times to UTC', () => {
    expect(fromLondon('2026-06-01', '10:00')).toBe('2026-06-01T09:00:00.000Z');
    expect(fromLondon('2026-12-01', '10:00')).toBe('2026-12-01T10:00:00.000Z');
  });

  it('round-trips through toLondon', () => {
    expect(toLondon('2026-06-01T09:00:00.000Z')).toEqual({ date: '2026-06-01', time: '10:00' });
    expect(toLondon('2026-06-01T23:30:00.000Z')).toEqual({ date: '2026-06-02', time: '00:30' });
  });

  it('moves a time skipped by the clocks going forward to the next valid instant', () => {
    expect(toLondon(fromLondon('2026-03-29', '01:30')).time).toBe('02:30');
  });

  it('handles date arithmetic and weekdays', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekdayMondayFirst('2026-06-01')).toBe(0); // Monday
    expect(weekdayMondayFirst('2026-06-07')).toBe(6); // Sunday
  });
});
