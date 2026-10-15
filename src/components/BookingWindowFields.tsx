import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fromLondon } from '@shared/londonTime';
import { blockedMessage, type BlockedBy } from '@shared/hierarchy';

export interface BookingWindow {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

/** UTC instants for a window entered in UK time, or null if incomplete or reversed. */
export function windowToIso(w: BookingWindow): { startsAt: string; endsAt: string } | null {
  try {
    const startsAt = fromLondon(w.startDate, w.startTime);
    const endsAt = fromLondon(w.endDate, w.endTime);
    return endsAt > startsAt ? { startsAt, endsAt } : null;
  } catch {
    return null;
  }
}

/** Start and end date/time inputs (UK time). Bookings may span several days. */
export function BookingWindowFields({
  value,
  onChange,
  minDate,
  idPrefix = 'bw',
}: {
  value: BookingWindow;
  onChange: (next: BookingWindow) => void;
  minDate?: string;
  idPrefix?: string;
}) {
  const set = (patch: Partial<BookingWindow>) => {
    const next = { ...value, ...patch };
    // Moving the start date past the end date drags the end date along.
    if (patch.startDate && next.endDate < next.startDate) next.endDate = next.startDate;
    onChange(next);
  };
  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">Booking dates and times (UK time)</legend>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor={`${idPrefix}-start-date`}>Start date</label>
          <input id={`${idPrefix}-start-date`} type="date" min={minDate} className="input" value={value.startDate} onChange={(e) => set({ startDate: e.target.value })} required />
        </div>
        <div>
          <label className="label" htmlFor={`${idPrefix}-start-time`}>Start time</label>
          <input id={`${idPrefix}-start-time`} type="time" className="input" value={value.startTime} onChange={(e) => set({ startTime: e.target.value })} required />
        </div>
        <div>
          <label className="label" htmlFor={`${idPrefix}-end-date`}>End date</label>
          <input id={`${idPrefix}-end-date`} type="date" min={value.startDate || minDate} className="input" value={value.endDate} onChange={(e) => set({ endDate: e.target.value })} required />
        </div>
        <div>
          <label className="label" htmlFor={`${idPrefix}-end-time`}>End time</label>
          <input id={`${idPrefix}-end-time`} type="time" className="input" value={value.endTime} onChange={(e) => set({ endTime: e.target.value })} required />
        </div>
      </div>
      <p className="text-xs text-gray-500">All times are UK time.</p>
    </fieldset>
  );
}

export type AvailabilityStatus = 'idle' | 'checking' | 'available' | 'closure' | 'conflict' | 'inactive' | 'restricted' | 'error';

export interface AvailabilityViolation {
  kind: 'min_notice' | 'max_advance' | 'opening_hours' | 'recurring_restriction';
  message: string;
}

export interface AvailabilityResult {
  status: AvailabilityStatus;
  /** Why the window is restricted (FR03), when status is 'restricted'. */
  violations: AvailabilityViolation[];
  /** The resource whose booking or closure makes this one unavailable. */
  blockedBy?: BlockedBy;
}

const IDLE: AvailabilityResult = { status: 'idle', violations: [] };

/** Live availability for a window, re-checked (debounced) as it changes. */
export function useAvailability(resourceId: string | undefined, window: { startsAt: string; endsAt: string } | null): AvailabilityResult {
  const [result, setResult] = useState<AvailabilityResult>(IDLE);
  const startsAt = window?.startsAt;
  const endsAt = window?.endsAt;
  useEffect(() => {
    if (!resourceId || !startsAt || !endsAt) {
      setResult(IDLE);
      return;
    }
    let current = true;
    setResult({ status: 'checking', violations: [] });
    const timer = setTimeout(() => {
      api
        .get<{ available: boolean; reason?: 'closure' | 'conflict' | 'inactive' | 'restricted'; violations?: AvailabilityViolation[]; blocked_by?: BlockedBy }>(
          `/availability?resource_id=${encodeURIComponent(resourceId)}&starts_at=${encodeURIComponent(startsAt)}&ends_at=${encodeURIComponent(endsAt)}`,
        )
        .then((r) => current && setResult({ status: r.available ? 'available' : (r.reason ?? 'conflict'), violations: r.violations ?? [], blockedBy: r.blocked_by }))
        .catch(() => current && setResult({ status: 'error', violations: [] }));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [resourceId, startsAt, endsAt]);
  return result;
}

export const AVAILABILITY_MESSAGE: Record<AvailabilityStatus, string> = {
  idle: '',
  checking: 'Checking availability…',
  available: 'Available',
  closure: 'Not available: the venue is closed for some of this time.',
  conflict: 'Not available: this clashes with an existing booking.',
  inactive: 'This resource is not currently available.',
  restricted: 'Not available: this time is outside the booking rules for this resource.',
  error: 'Could not check availability right now.',
};

/** The availability line, naming the parent or child that blocks the time when there is one. */
export function availabilityMessage(result: AvailabilityResult): string {
  if (result.status === 'conflict') return `Not available: ${blockedMessage('booked', result.blockedBy)}`;
  if (result.status === 'closure') return `Not available: ${blockedMessage('closed', result.blockedBy)}`;
  return AVAILABILITY_MESSAGE[result.status];
}

/** The live availability line under a booking window, with any rule details. */
export function AvailabilityNotice({ result }: { result: AvailabilityResult }) {
  if (result.status === 'idle') return null;
  const colour = result.status === 'available' ? 'text-scout-green' : result.status === 'checking' ? 'text-gray-500' : 'text-scout-red';
  return (
    <div role="status">
      <p className={`text-sm font-bold ${colour}`}>{availabilityMessage(result)}</p>
      {result.violations.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-sm text-scout-red">
          {result.violations.map((v) => <li key={v.kind + v.message}>{v.message}</li>)}
        </ul>
      )}
    </div>
  );
}
