import { addDays, fromLondon, toLondon, weekdayMondayFirst } from './londonTime';

/**
 * Advanced availability rules (FR03): minimum notice, maximum advance window,
 * recurring closed periods and opening hours. Pure; the API loads the rules.
 */

export type RestrictionKind = 'min_notice' | 'max_advance' | 'opening_hours' | 'recurring_restriction' | 'min_length' | 'max_length';

/** Restrictions an authorised administrator may override. Exceptional closures and conflicts can never be overridden. */
export const OVERRIDABLE: RestrictionKind[] = ['min_notice', 'max_advance', 'opening_hours', 'recurring_restriction', 'min_length', 'max_length'];

export const RESTRICTION_LABEL: Record<RestrictionKind, string> = {
  min_notice: 'Minimum notice',
  max_advance: 'Advance booking window',
  opening_hours: 'Opening hours',
  recurring_restriction: 'Recurring restriction',
  min_length: 'Minimum length',
  max_length: 'Maximum length',
};

/**
 * How long a booking of a resource must or may be (null: no rule). Hours
 * suit hall-style resources; nights (UK calendar days between start and end)
 * suit nightly ones, where a minimum of 1 night means "overnight only".
 */
export interface BookingLength {
  minDurationMinutes: number | null;
  maxDurationMinutes: number | null;
  minNights: number | null;
  maxNights: number | null;
}

/** Nights a booking spans: UK calendar days from its start date to its end date. */
export function nightsBetween(startsAt: string, endsAt: string): number {
  const day = (iso: string) => Date.parse(`${toLondon(iso).date}T00:00:00Z`) / 86_400_000;
  return Math.round(day(endsAt) - day(startsAt));
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Each length rule as a sentence, for customers. */
export function describeLength(l: BookingLength): string[] {
  const out: string[] = [];
  if (l.minNights === 1 && !l.maxNights) out.push('Overnight bookings only: your booking must end on a later day than it starts.');
  else if (l.minNights && l.maxNights) out.push(`Book for ${l.minNights === l.maxNights ? plural(l.minNights, 'night') : `${l.minNights} to ${plural(l.maxNights, 'night')}`}.`);
  else if (l.minNights) out.push(`Book for at least ${plural(l.minNights, 'night')}.`);
  else if (l.maxNights) out.push(`Book for at most ${plural(l.maxNights, 'night')}.`);
  if (l.minDurationMinutes) out.push(`Book for at least ${humanMinutes(l.minDurationMinutes)}.`);
  if (l.maxDurationMinutes) out.push(`Book for at most ${humanMinutes(l.maxDurationMinutes)}.`);
  return out;
}

/** A booking's breaches of its resource's length rules. */
export function evaluateLength(startsAt: string, endsAt: string, l: BookingLength): RuleViolation[] {
  const minutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000;
  const nights = nightsBetween(startsAt, endsAt);
  const out: RuleViolation[] = [];
  if (l.minNights && nights < l.minNights) {
    out.push({
      kind: 'min_length',
      message: l.minNights === 1
        ? 'This resource can only be booked overnight: the booking must end on a later day than it starts.'
        : `This resource must be booked for at least ${plural(l.minNights, 'night')}.`,
    });
  }
  if (l.maxNights && nights > l.maxNights) out.push({ kind: 'max_length', message: `This resource can be booked for at most ${plural(l.maxNights, 'night')}.` });
  if (l.minDurationMinutes && minutes < l.minDurationMinutes) out.push({ kind: 'min_length', message: `This resource must be booked for at least ${humanMinutes(l.minDurationMinutes)}.` });
  if (l.maxDurationMinutes && minutes > l.maxDurationMinutes) out.push({ kind: 'max_length', message: `This resource can be booked for at most ${humanMinutes(l.maxDurationMinutes)}.` });
  return out;
}

export interface AvailabilityRule {
  id: string;
  resource_id: string;
  rule_type: 'closed' | 'open';
  days_of_week: string; // "0,1,2" Monday = 0
  start_time: string; // HH:mm
  end_time: string; // HH:mm
  valid_from: string | null; // YYYY-MM-DD inclusive
  valid_to: string | null;
  label: string | null;
}

export interface RuleViolation {
  kind: RestrictionKind;
  message: string;
  ruleId?: string;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function parseDays(days: string): number[] {
  return days
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

export function describeRule(rule: Pick<AvailabilityRule, 'rule_type' | 'days_of_week' | 'start_time' | 'end_time' | 'valid_from' | 'valid_to' | 'label'>): string {
  const days = parseDays(rule.days_of_week);
  const dayText = days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(', ');
  const allDay = rule.start_time === rule.end_time && rule.start_time === '00:00';
  const time = allDay ? 'all day' : `${rule.start_time}–${rule.end_time}`;
  const season = rule.valid_from || rule.valid_to ? ` (${rule.valid_from ?? '…'} to ${rule.valid_to ?? '…'})` : '';
  const prefix = rule.rule_type === 'open' ? 'Open' : 'Unavailable';
  return `${rule.label ? `${rule.label}: ` : ''}${prefix} ${dayText} ${time}${season}`;
}

/** The instants a rule covers on one UK date, or null if it does not apply that day. */
function windowOn(rule: AvailabilityRule, date: string): [number, number] | null {
  if (rule.valid_from && date < rule.valid_from) return null;
  if (rule.valid_to && date > rule.valid_to) return null;
  if (!parseDays(rule.days_of_week).includes(weekdayMondayFirst(date))) return null;
  const start = Date.parse(fromLondon(date, rule.start_time));
  const endDate = rule.end_time <= rule.start_time ? addDays(date, 1) : date;
  const end = Date.parse(fromLondon(endDate, rule.end_time));
  return end > start ? [start, end] : null;
}

/** Every rule window that could touch [start, end): dates from the day before the start to the end date. */
function windows(rule: AvailabilityRule, startsAt: string, endsAt: string): [number, number][] {
  const out: [number, number][] = [];
  const last = toLondon(endsAt).date;
  for (let d = addDays(toLondon(startsAt).date, -1); d <= last; d = addDays(d, 1)) {
    const w = windowOn(rule, d);
    if (w) out.push(w);
  }
  return out;
}

function humanMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

/**
 * Check a requested window against a resource's restrictions. Returns every
 * violation (empty when the booking is allowed).
 */
export function evaluateRestrictions(params: {
  startsAt: string;
  endsAt: string;
  now: number;
  minNoticeMinutes: number | null;
  maxAdvanceDays: number | null;
  rules: AvailabilityRule[];
  /**
   * Length rules apply to a whole booking. Left out when checking calendar
   * slots, which are only part of a booking.
   */
  length?: BookingLength;
}): RuleViolation[] {
  const start = Date.parse(params.startsAt);
  const end = Date.parse(params.endsAt);
  const violations: RuleViolation[] = [];

  if (params.minNoticeMinutes && start - params.now < params.minNoticeMinutes * 60_000) {
    violations.push({ kind: 'min_notice', message: `This resource must be booked at least ${humanMinutes(params.minNoticeMinutes)} in advance.` });
  }
  if (params.maxAdvanceDays && start - params.now > params.maxAdvanceDays * 86_400_000) {
    violations.push({ kind: 'max_advance', message: `This resource can only be booked up to ${params.maxAdvanceDays} days ahead.` });
  }
  if (params.length) violations.push(...evaluateLength(params.startsAt, params.endsAt, params.length));

  for (const rule of params.rules.filter((r) => r.rule_type === 'closed')) {
    if (windows(rule, params.startsAt, params.endsAt).some(([ws, we]) => ws < end && start < we)) {
      violations.push({ kind: 'recurring_restriction', message: `Not available: ${describeRule(rule)}.`, ruleId: rule.id });
    }
  }

  const open = params.rules.filter((r) => r.rule_type === 'open');
  if (open.length) {
    const merged = open
      .flatMap((r) => windows(r, params.startsAt, params.endsAt))
      .sort((a, b) => a[0] - b[0])
      .reduce<[number, number][]>((acc, w) => {
        const last = acc[acc.length - 1];
        if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
        else acc.push([...w]);
        return acc;
      }, []);
    const covered = merged.some(([ws, we]) => ws <= start && we >= end);
    if (!covered) {
      violations.push({ kind: 'opening_hours', message: `Outside opening hours (${open.map(describeRule).join('; ')}).` });
    }
  }
  return violations;
}
