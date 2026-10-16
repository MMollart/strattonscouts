// Release 3 / FR10: financial reporting helpers. All amounts are integer pence
// taken from the price snapshot stored on each booking. These are booking
// values, not payments received.

import { addDays, fromLondon, londonToday } from './londonTime';

export const FINANCE_STATUSES = ['confirmed', 'provisional', 'pending_approval', 'cancelled', 'rejected', 'expired'] as const;
export type FinanceStatus = (typeof FINANCE_STATUSES)[number];

export const FINANCE_STATUS_LABEL: Record<FinanceStatus, string> = {
  confirmed: 'Confirmed',
  provisional: 'Provisional',
  pending_approval: 'Awaiting approval',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired',
};

export const PERIOD_PRESETS = ['this_month', 'last_month', 'this_year', 'last_year', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface Period {
  preset: PeriodPreset;
  /** First and last UK calendar day, inclusive (YYYY-MM-DD). */
  from: string;
  to: string;
  /** UTC instants: start of `from` to the start of the day after `to`. */
  startIso: string;
  endIso: string;
}

const ymd = /^\d{4}-\d{2}-\d{2}$/;

/** A reporting period in UK time. Custom periods need from and to (inclusive). */
export function resolvePeriod(preset: string | null, from?: string | null, to?: string | null, today = londonToday()): Period | { error: string } {
  const p = (preset || 'this_month') as PeriodPreset;
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const monthStart = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const lastDay = (first: string) => {
    const [yy, mm] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
    return addDays(mm === 12 ? monthStart(yy + 1, 1) : monthStart(yy, mm + 1), -1);
  };
  let f: string;
  let t: string;
  switch (p) {
    case 'this_month':
      f = monthStart(y, m);
      t = lastDay(f);
      break;
    case 'last_month':
      f = m === 1 ? monthStart(y - 1, 12) : monthStart(y, m - 1);
      t = lastDay(f);
      break;
    case 'this_year':
      f = `${y}-01-01`;
      t = `${y}-12-31`;
      break;
    case 'last_year':
      f = `${y - 1}-01-01`;
      t = `${y - 1}-12-31`;
      break;
    case 'custom':
      if (!from || !to || !ymd.test(from) || !ymd.test(to)) return { error: 'Choose a start and end date' };
      if (to < from) return { error: 'The end date must be on or after the start date' };
      if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) return { error: 'Choose a period of three years or less' };
      f = from;
      t = to;
      break;
    default:
      return { error: 'Unknown period' };
  }
  return { preset: p, from: f, to: t, startIso: fromLondon(f, '00:00'), endIso: fromLondon(addDays(t, 1), '00:00') };
}

/**
 * Split `total` pence into integer parts proportional to `weights`, so the
 * parts always add up to exactly `total` (largest remainder; ties go to the
 * earliest part).
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map((x) => Math.floor(x));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i] += 1;
  return parts;
}

/**
 * The UK calendar days a booking uses, each with the share of its value
 * allocated to it (by time on that day). The shares add up to the booking's
 * value exactly. A booking with no duration falls on its start day.
 */
export function usageDays(startsAt: string, endsAt: string, valuePence: number): { day: string; pence: number }[] {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const days: { day: string; ms: number }[] = [];
  let day = londonDayOf(startsAt);
  // Bookings are short (a few days at most); stop safely at a year.
  for (let guard = 0; guard < 400; guard++) {
    const dayStart = Date.parse(fromLondon(day, '00:00'));
    if (dayStart >= end && days.length) break;
    const dayEnd = Date.parse(fromLondon(addDays(day, 1), '00:00'));
    const ms = Math.max(0, Math.min(end, dayEnd) - Math.max(start, dayStart));
    days.push({ day, ms });
    if (dayEnd >= end) break;
    day = addDays(day, 1);
  }
  const parts = allocate(valuePence, days.map((d) => d.ms));
  return days.map((d, i) => ({ day: d.day, pence: parts[i] }));
}

/** The UK calendar day (YYYY-MM-DD) of an instant. */
export function londonDayOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

