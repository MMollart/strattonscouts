import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fromLondon } from '@shared/londonTime';

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

export type AvailabilityStatus = 'idle' | 'checking' | 'available' | 'closure' | 'conflict' | 'inactive' | 'error';

/** Live availability for a window, re-checked (debounced) as it changes. */
export function useAvailability(resourceId: string | undefined, window: { startsAt: string; endsAt: string } | null): AvailabilityStatus {
  const [status, setStatus] = useState<AvailabilityStatus>('idle');
  const startsAt = window?.startsAt;
  const endsAt = window?.endsAt;
  useEffect(() => {
    if (!resourceId || !startsAt || !endsAt) {
      setStatus('idle');
      return;
    }
    let current = true;
    setStatus('checking');
    const timer = setTimeout(() => {
      api
        .get<{ available: boolean; reason?: 'closure' | 'conflict' | 'inactive' }>(
          `/availability?resource_id=${encodeURIComponent(resourceId)}&starts_at=${encodeURIComponent(startsAt)}&ends_at=${encodeURIComponent(endsAt)}`,
        )
        .then((r) => current && setStatus(r.available ? 'available' : (r.reason ?? 'conflict')))
        .catch(() => current && setStatus('error'));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [resourceId, startsAt, endsAt]);
  return status;
}

export const AVAILABILITY_MESSAGE: Record<AvailabilityStatus, string> = {
  idle: '',
  checking: 'Checking availability…',
  available: 'Available',
  closure: 'Not available: the venue is closed for some of this time.',
  conflict: 'Not available: this clashes with an existing booking.',
  inactive: 'This resource is not currently available.',
  error: 'Could not check availability right now.',
};
