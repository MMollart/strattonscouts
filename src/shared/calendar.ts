import { addDays, fromLondon, toLondon, weekdayMondayFirst } from './londonTime';

/**
 * Date arithmetic for the admin calendar (FR09). All dates are UK calendar
 * days (YYYY-MM-DD); weeks start on Monday.
 */

export type CalendarView = 'day' | 'week' | 'month';

export interface CalendarRange {
  /** The days shown, in order. */
  days: string[];
  /** UTC instants bounding the range, for the bookings query. */
  from: string;
  to: string;
}

export function startOfWeek(date: string): string {
  return addDays(date, -weekdayMondayFirst(date));
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The days a view shows around `date`. A month view shows whole weeks. */
export function calendarRange(view: CalendarView, date: string): CalendarRange {
  let first = date;
  let count = 1;
  if (view === 'week') {
    first = startOfWeek(date);
    count = 7;
  } else if (view === 'month') {
    first = startOfWeek(monthStart(date));
    const nextMonth = addDays(monthStart(date), 32).slice(0, 7);
    const lastShown = addDays(startOfWeek(addDays(`${nextMonth}-01`, -1)), 6);
    count = Math.round((Date.parse(`${lastShown}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000) + 1;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  return { days, from: fromLondon(days[0], '00:00'), to: fromLondon(addDays(days[days.length - 1], 1), '00:00') };
}

/** The date `step` views before or after `date`. */
export function shiftDate(view: CalendarView, date: string, step: number): string {
  if (view === 'day') return addDays(date, step);
  if (view === 'week') return addDays(date, step * 7);
  const [y, m] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + step;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

export interface Span {
  starts_at: string;
  ends_at: string;
}

/** Whether a booking touches a UK day. */
export function onDay(b: Span, day: string): boolean {
  return b.starts_at < fromLondon(addDays(day, 1), '00:00') && b.ends_at > fromLondon(day, '00:00');
}

/**
 * Vertical position of a booking within a day column, as fractions of the
 * visible hours (startHour to endHour), clipped to the day.
 */
export function dayPosition(b: Span, day: string, startHour = 6, endHour = 24): { top: number; height: number; continuesBefore: boolean; continuesAfter: boolean } {
  const dayStart = Date.parse(fromLondon(day, '00:00'));
  const dayEnd = Date.parse(fromLondon(addDays(day, 1), '00:00'));
  const s = Math.max(Date.parse(b.starts_at), dayStart);
  const e = Math.min(Date.parse(b.ends_at), dayEnd);
  // Hours since local midnight, measured on the wall clock so BST days still line up.
  const hour = (t: number) => {
    if (t >= dayEnd) return 24;
    const { time } = toLondon(t);
    const [h, m] = time.split(':').map(Number);
    return h + m / 60;
  };
  const span = endHour - startHour;
  const top = Math.min(Math.max((hour(s) - startHour) / span, 0), 1);
  const bottom = Math.min(Math.max((hour(e) - startHour) / span, 0), 1);
  return {
    top,
    height: Math.max(bottom - top, 0.02),
    continuesBefore: Date.parse(b.starts_at) < dayStart,
    continuesAfter: Date.parse(b.ends_at) > dayEnd,
  };
}
