/**
 * The venue works in UK local time (GMT/BST). These helpers convert between
 * UTC instants and Europe/London wall-clock dates and times, independent of
 * the visitor's own browser time zone.
 */

export const VENUE_TIME_ZONE = 'Europe/London';

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: VENUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface LondonParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
}

/** UK wall-clock date and time of a UTC instant. */
export function toLondon(instant: string | number | Date): LondonParts {
  const parts = Object.fromEntries(
    partsFormat.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function londonOffsetMs(utcMs: number): number {
  const { date, time } = toLondon(utcMs);
  return Date.parse(`${date}T${time}:00Z`) - Math.floor(utcMs / 60000) * 60000;
}

/**
 * UTC ISO string for a UK wall-clock date (YYYY-MM-DD) and time (HH:mm).
 * Times that do not exist (the hour skipped when clocks go forward) resolve
 * to the following valid instant.
 */
export function fromLondon(date: string, time: string): string {
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(naive)) throw new Error('Invalid date or time');
  let utc = naive - londonOffsetMs(naive);
  utc = naive - londonOffsetMs(utc);
  return new Date(utc).toISOString();
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the UK. */
export function londonToday(): string {
  return toLondon(Date.now()).date;
}

/** Day of week for a YYYY-MM-DD date, Monday = 0. */
export function weekdayMondayFirst(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Human-readable UK date and time, e.g. "Sat 6 Jun 2026, 10:00". */
export function formatLondon(instant: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: VENUE_TIME_ZONE, ...options }).format(new Date(instant));
}
