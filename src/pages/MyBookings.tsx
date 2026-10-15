import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { formatGBP } from '@shared/pricing';
import { formatLondon, toLondon } from '@shared/londonTime';

interface BookingRow {
  id: string;
  reference: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  total_amount_pence: number;
  organisation_name: string | null;
  booked_by: string;
  is_mine: boolean;
  series_id: string | null;
  has_pending_amendment: boolean;
}

type When = 'upcoming' | 'past' | 'all';

const STATUS_OPTIONS = [
  ['', 'All statuses'],
  ['confirmed', 'Confirmed'],
  ['pending_approval', 'Awaiting approval'],
  ['provisional', 'Provisional'],
  ['cancelled', 'Cancelled'],
  ['rejected', 'Not approved'],
  ['expired', 'Expired'],
] as const;

function formatRange(startsAt: string, endsAt: string): string {
  const day = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } as const;
  const time = { hour: '2-digit', minute: '2-digit' } as const;
  if (toLondon(startsAt).date === toLondon(endsAt).date) {
    return `${formatLondon(startsAt, day)}, ${formatLondon(startsAt, time)}–${formatLondon(endsAt, time)}`;
  }
  return `${formatLondon(startsAt, { ...day, ...time })} to ${formatLondon(endsAt, { ...day, ...time })}`;
}

export default function MyBookings() {
  const { data, loading, error } = useApi<BookingRow[]>('/bookings');
  const [when, setWhen] = useState<When>('upcoming');
  const [status, setStatus] = useState('');
  const nowIso = new Date().toISOString();
  const rows = (data ?? [])
    .filter((b) => (when === 'all' ? true : when === 'upcoming' ? b.ends_at > nowIso : b.ends_at <= nowIso))
    .filter((b) => !status || b.status === status)
    .sort((a, b) => (when === 'upcoming' ? a.starts_at.localeCompare(b.starts_at) : b.starts_at.localeCompare(a.starts_at)));

  return (
    <div>
      <h1 className="text-3xl">My bookings</h1>
      <p className="mt-2 text-gray-600">Your personal bookings and those of organisations you belong to.</p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Show" className="flex overflow-hidden rounded-xl border">
          {(['upcoming', 'past', 'all'] as When[]).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={when === w}
              className={`px-4 py-2 text-sm font-bold capitalize ${when === w ? 'bg-scout-purple text-white' : 'bg-white text-gray-700'}`}
              onClick={() => setWhen(w)}
            >
              {w}
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="mb-status">Status</label>
          <select id="mb-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className="mt-6">
        {loading && <Spinner />}
        {error && <ErrorState message={error} />}
        {!loading && !error && data && data.length === 0 && (
          <EmptyState title="No bookings yet">
            Browse <Link to="/resources" className="font-bold text-scout-purple">our resources</Link> to make your first booking.
          </EmptyState>
        )}
        {!loading && !error && data && data.length > 0 && rows.length === 0 && <EmptyState title="No bookings match these filters" />}
        {!loading && !error && rows.length > 0 && (
          <div className="space-y-3">
            {rows.map((b) => (
              <Link
                key={b.id}
                to={`/bookings/${b.id}`}
                className="card flex flex-col gap-2 transition hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-black">{b.resource_name}</p>
                  <p className="text-sm text-gray-600">{formatRange(b.starts_at, b.ends_at)}</p>
                  <p className="text-xs text-gray-400">
                    Ref {b.reference}
                    {b.organisation_name && <> · {b.organisation_name}{!b.is_mine && <> · booked by {b.booked_by}</>}</>}
                    {b.series_id && <> · repeating booking</>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold">{formatGBP(b.total_amount_pence)}</span>
                  {b.has_pending_amendment && <span className="badge bg-scout-yellow/30 text-yellow-800">change requested</span>}
                  <StatusBadge status={b.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
