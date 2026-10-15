import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { ErrorState } from './ui';
import { formatGBP } from '@shared/pricing';
import { addDays, formatLondon } from '@shared/londonTime';
import { describePattern, FREQUENCY_LABEL, MAX_OCCURRENCES, type Frequency, type MonthlyMode } from '@shared/recurrence';
import type { BookingWindow } from './BookingWindowFields';

interface OccurrencePreview {
  date: string;
  starts_at: string;
  ends_at: string;
  available: boolean;
  reason?: string;
  message?: string;
  price?: { total_pence: number };
}

interface Preview {
  occurrences: OccurrencePreview[];
  available_count: number;
  unavailable_count: number;
  total_pence: number;
  requires_approval: boolean;
}

/**
 * Repeat options for a booking (FR05). The customer reviews every date before
 * submitting; unavailable dates are only left out when they explicitly choose
 * to continue without them.
 */
export function RecurringBooking({
  resourceId,
  resourceName,
  organisationId,
  onBehalfOfUserId,
  window: win,
  onCreated,
}: {
  resourceId: string;
  resourceName: string;
  organisationId?: string | null;
  onBehalfOfUserId?: string;
  window: BookingWindow;
  onCreated?: (seriesId: string) => void;
}) {
  const navigate = useNavigate();
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>('day_of_month');
  const [endBy, setEndBy] = useState<'date' | 'count'>('count');
  const [untilDate, setUntilDate] = useState(() => addDays(win.startDate, 70));
  const [count, setCount] = useState('10');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [excludeUnavailable, setExcludeUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const sameDay = win.endDate === win.startDate && win.endTime > win.startTime;
  const overnight = win.endDate === addDays(win.startDate, 1) && win.endTime <= win.startTime;
  const fits = sameDay || overnight;

  const body = {
    resource_id: resourceId,
    organisation_id: organisationId ?? null,
    ...(onBehalfOfUserId ? { on_behalf_of_user_id: onBehalfOfUserId } : {}),
    frequency,
    monthly_mode: monthlyMode,
    start_date: win.startDate,
    start_time: win.startTime,
    end_time: win.endTime,
    until_date: endBy === 'date' ? untilDate : null,
    count: endBy === 'count' ? Number(count) : null,
  };
  const key = JSON.stringify(body);

  // Any change to the pattern invalidates the review.
  useEffect(() => {
    setPreview(null);
    setExcludeUnavailable(false);
    setError(null);
  }, [key]);

  async function review() {
    setWorking(true);
    setError(null);
    try {
      setPreview(await api.post<Preview>('/series/preview', body));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not check these dates');
    } finally {
      setWorking(false);
    }
  }

  async function submit() {
    if (!preview) return;
    setWorking(true);
    setError(null);
    try {
      const exclude_dates = excludeUnavailable ? preview.occurrences.filter((o) => !o.available).map((o) => o.date) : [];
      const created = await api.post<{ id: string }>('/series', { ...body, exclude_dates });
      if (onCreated) onCreated(created.id);
      else navigate(`/series/${created.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the recurring booking');
      // Availability may have changed; show the latest picture.
      void review();
    } finally {
      setWorking(false);
    }
  }

  if (!fits) {
    return <p className="text-sm text-scout-red">A repeating booking must finish on the same day, or the next morning for an overnight booking.</p>;
  }

  const blocked = !!preview && preview.unavailable_count > 0 && !excludeUnavailable;
  const pattern = { frequency, monthlyMode, startDate: win.startDate, startTime: win.startTime, endTime: win.endTime };

  return (
    <fieldset className="space-y-3 rounded-xl border border-gray-200 p-4">
      <legend className="px-1 font-bold">Repeat</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="rec-frequency">How often</label>
          <select id="rec-frequency" className="input" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </select>
        </div>
        {frequency === 'monthly' && (
          <div>
            <label className="label" htmlFor="rec-monthly">Each month on</label>
            <select id="rec-monthly" className="input" value={monthlyMode} onChange={(e) => setMonthlyMode(e.target.value as MonthlyMode)}>
              <option value="day_of_month">The same date</option>
              <option value="nth_weekday">The same weekday (e.g. first Monday)</option>
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="rec-end">Ends</label>
          <select id="rec-end" className="input" value={endBy} onChange={(e) => setEndBy(e.target.value as 'date' | 'count')}>
            <option value="count">After a number of bookings</option>
            <option value="date">On a date</option>
          </select>
        </div>
        {endBy === 'count' ? (
          <div>
            <label className="label" htmlFor="rec-count">Number of bookings</label>
            <input id="rec-count" type="number" min={2} max={MAX_OCCURRENCES} className="input" value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="rec-until">Last date</label>
            <input id="rec-until" type="date" min={win.startDate} className="input" value={untilDate} onChange={(e) => setUntilDate(e.target.value)} />
          </div>
        )}
      </div>
      <p className="text-sm text-gray-600">{describePattern(pattern)}, starting {formatLondon(`${win.startDate}T12:00:00Z`, { dateStyle: 'medium' })}. Up to {MAX_OCCURRENCES} bookings.</p>

      {!preview && <button type="button" className="btn-secondary" onClick={review} disabled={working}>{working ? 'Checking dates…' : 'Review dates'}</button>}

      {preview && (
        <div className="space-y-3">
          <ul className="max-h-72 divide-y overflow-y-auto rounded-xl border bg-white text-sm" aria-label={`Dates for ${resourceName}`}>
            {preview.occurrences.map((o) => (
              <li key={o.date} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 ${o.available ? '' : 'bg-scout-red/5'}`}>
                <span>
                  <span className="font-bold">{formatLondon(o.starts_at, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>{' '}
                  {formatLondon(o.starts_at, { timeStyle: 'short' })}–{formatLondon(o.ends_at, { timeStyle: 'short' })} · {resourceName}
                </span>
                {o.available
                  ? <span>{formatGBP(o.price?.total_pence ?? 0)}</span>
                  : <span className="font-bold text-scout-red">{excludeUnavailable ? 'Removed: ' : 'Not available: '}{o.message}</span>}
              </li>
            ))}
          </ul>
          {preview.unavailable_count > 0 && (
            <div className="rounded-xl bg-scout-red/10 p-3 text-sm">
              <p className="font-bold text-scout-red">
                {preview.unavailable_count} of {preview.occurrences.length} dates are not available.
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={excludeUnavailable} onChange={(e) => setExcludeUnavailable(e.target.checked)} />
                Remove these dates and continue with the {preview.available_count} available dates
              </label>
              <p className="mt-1 text-gray-600">Otherwise, change the pattern or cancel the request.</p>
            </div>
          )}
          <p className="flex justify-between text-lg">
            <span className="font-bold">Total for {preview.available_count} bookings</span>
            <span className="font-black text-scout-purple">{formatGBP(preview.total_pence)}</span>
          </p>
          {preview.requires_approval && <p className="text-sm text-yellow-800">Every date needs administrator approval.</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={submit} disabled={working || blocked || preview.available_count === 0}>
              {working ? 'Submitting…' : preview.requires_approval ? 'Request recurring booking' : 'Confirm recurring booking'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPreview(null)}>Change</button>
          </div>
        </div>
      )}
      {error && <ErrorState message={error} />}
    </fieldset>
  );
}
