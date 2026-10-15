import { addDays, fromLondon, weekdayMondayFirst } from './londonTime';

/**
 * Recurring bookings (FR05): generate the occurrences of a series. Dates and
 * times are UK wall-clock, so a 19:00 weekly booking stays at 19:00 across
 * BST changes. Pure; shared by the preview UI and the API.
 */

export type Frequency = 'daily' | 'weekly' | 'fortnightly' | 'monthly';
/** Monthly by the same day of the month (the 14th) or the same weekday position (the first Monday). */
export type MonthlyMode = 'day_of_month' | 'nth_weekday';

export const MAX_OCCURRENCES = 104;

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  fortnightly: 'Every two weeks',
  monthly: 'Every month',
};

export interface RecurrencePattern {
  frequency: Frequency;
  monthlyMode?: MonthlyMode;
  startDate: string; // YYYY-MM-DD, the first occurrence
  startTime: string; // HH:mm
  endTime: string; // HH:mm; at or before startTime means the next day
  untilDate?: string | null; // inclusive
  count?: number | null;
}

export interface Occurrence {
  date: string;
  startsAt: string;
  endsAt: string;
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'last'];
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Position of a date's weekday within its month: 0 = first … 3 = fourth, 4 = last. */
function weekdayPosition(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  if (d + 7 > daysInMonth(y, m)) return 4;
  return Math.floor((d - 1) / 7);
}

/** The date in year/month for a weekday at a position (4 = last), or null. */
function nthWeekday(year: number, month: number, weekday: number, position: number): string {
  const first = weekdayMondayFirst(ymd(year, month, 1));
  const firstMatch = 1 + ((weekday - first + 7) % 7);
  if (position < 4) return ymd(year, month, firstMatch + position * 7);
  let day = firstMatch;
  while (day + 7 <= daysInMonth(year, month)) day += 7;
  return ymd(year, month, day);
}

/** A readable summary, e.g. "Every week on Tuesday, 19:00–21:00". */
export function describePattern(p: RecurrencePattern): string {
  const time = `${p.startTime}–${p.endTime}`;
  const weekday = WEEKDAY[weekdayMondayFirst(p.startDate)];
  if (p.frequency === 'daily') return `Every day, ${time}`;
  if (p.frequency === 'weekly') return `Every week on ${weekday}, ${time}`;
  if (p.frequency === 'fortnightly') return `Every two weeks on ${weekday}, ${time}`;
  if (p.monthlyMode === 'nth_weekday') return `The ${ORDINAL[weekdayPosition(p.startDate)]} ${weekday} of every month, ${time}`;
  return `Every month on day ${Number(p.startDate.slice(8))}, ${time}`;
}

/**
 * Every occurrence of a pattern, ending at untilDate or after count
 * occurrences (whichever comes first), capped at MAX_OCCURRENCES. A monthly
 * day-of-month series skips months without that day (no 31 February).
 */
export function generateOccurrences(p: RecurrencePattern): Occurrence[] {
  const limit = Math.min(p.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const overnight = p.endTime <= p.startTime;
  const dates: string[] = [];
  const push = (date: string) => {
    if (p.untilDate && date > p.untilDate) return false;
    dates.push(date);
    return dates.length < limit;
  };

  if (p.frequency === 'monthly') {
    const [y0, m0, d0] = p.startDate.split('-').map(Number);
    const weekday = weekdayMondayFirst(p.startDate);
    const position = weekdayPosition(p.startDate);
    // A month can be skipped, so bound the walk by months rather than dates.
    for (let i = 0; i < MAX_OCCURRENCES * 2; i++) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      let date: string | null;
      if (p.monthlyMode === 'nth_weekday') date = nthWeekday(y, m, weekday, position);
      else date = d0 <= daysInMonth(y, m) ? ymd(y, m, d0) : null;
      if (!date) continue;
      if (p.untilDate && date > p.untilDate) break;
      if (!push(date)) break;
    }
  } else {
    const step = p.frequency === 'daily' ? 1 : p.frequency === 'weekly' ? 7 : 14;
    for (let date = p.startDate; push(date); date = addDays(date, step)) {
      if (p.untilDate && addDays(date, step) > p.untilDate) break;
    }
  }

  return dates.map((date) => ({
    date,
    startsAt: fromLondon(date, p.startTime),
    endsAt: fromLondon(overnight ? addDays(date, 1) : date, p.endTime),
  }));
}
