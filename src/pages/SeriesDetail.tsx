import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorState, Spinner, StatusBadge } from '../components/ui';
import { formatGBP } from '@shared/pricing';
import { formatLondon, toLondon } from '@shared/londonTime';
import { describePattern, type Frequency, type MonthlyMode } from '@shared/recurrence';

interface Occurrence {
  id: string;
  reference: string;
  resource_id: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  total_amount_pence: number;
}

interface Series {
  id: string;
  reference: string;
  resource_id: string;
  resource_name: string;
  customer_name: string;
  organisation_name: string | null;
  frequency: Frequency;
  monthly_mode: MonthlyMode | null;
  start_date: string;
  start_time: string;
  end_time: string;
  excluded_dates: string[];
  status: string;
  can_manage: boolean;
  occurrences: Occurrence[];
}

const ACTIVE = ['pending_approval', 'confirmed', 'provisional'];

/** A recurring series with all its dates (FR05). */
export default function SeriesDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, loading, error, setData } = useApi<Series>(`/series/${id}`, [id]);
  const reload = async () => setData(await api.get<Series>(`/series/${id}`));
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ booking: Occurrence; scope: 'one' | 'future'; start: string; end: string } | null>(null);
  const [working, setWorking] = useState(false);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const upcoming = (o: Occurrence) => ACTIVE.includes(o.status) && new Date(o.starts_at).getTime() > Date.now();
  const admin = can('bookings.manage');
  const canCancel = (o: Occurrence) => data.can_manage && ACTIVE.includes(o.status) && (admin || upcoming(o));
  const activeTotal = data.occurrences.filter((o) => ACTIVE.includes(o.status)).reduce((s, o) => s + o.total_amount_pence, 0);

  async function run(action: () => Promise<unknown>, done: string) {
    setWorking(true);
    setActionError(null);
    setMessage(null);
    try {
      await action();
      setMessage(done);
      setEditing(null);
      await reload();
    } catch (e) {
      const details = e instanceof ApiError ? (e.details as { problems?: { starts_at: string; message: string }[] } | undefined) : undefined;
      const problems = details?.problems?.map((p) => `${formatLondon(p.starts_at, { dateStyle: 'medium' })}: ${p.message}`).join(' ');
      setActionError(e instanceof ApiError ? `${e.message}${problems ? `. ${problems}` : ''}` : 'Action failed');
    } finally {
      setWorking(false);
    }
  }

  const cancelOne = (o: Occurrence) =>
    confirm(`Cancel the booking on ${formatLondon(o.starts_at, { dateStyle: 'medium' })}?`) &&
    run(() => api.post(`/bookings/${o.id}/cancel`), 'That date has been cancelled.');
  const cancelFuture = (o: Occurrence) =>
    confirm('Cancel this date and every later date in the series?') &&
    run(() => api.post(`/series/${data.id}/cancel`, { scope: 'future', from_booking_id: o.id }), 'The remaining dates have been cancelled.');
  const cancelAll = () =>
    confirm('Cancel every remaining date in this series?') &&
    run(() => api.post(`/series/${data.id}/cancel`, { scope: 'all' }), 'The series has been cancelled.');

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/my-bookings" className="mb-4 inline-block text-sm font-bold text-scout-purple">← My bookings</Link>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl">{data.resource_name}</h1>
          <p className="text-gray-600">
            {describePattern({ frequency: data.frequency, monthlyMode: data.monthly_mode ?? undefined, startDate: data.start_date, startTime: data.start_time, endTime: data.end_time })}
          </p>
          <p className="text-sm text-gray-500">
            Series {data.reference} · {data.customer_name}{data.organisation_name ? ` for ${data.organisation_name}` : ''}
          </p>
        </div>
        <StatusBadge status={data.status === 'cancelled' ? 'cancelled' : 'confirmed'} />
      </div>
      {data.excluded_dates.length > 0 && (
        <p className="mt-2 text-sm text-gray-600">Left out when booked: {data.excluded_dates.map((d) => formatLondon(`${d}T12:00:00Z`, { dateStyle: 'medium' })).join(', ')}</p>
      )}

      {message && <p className="mt-4 rounded-lg bg-scout-green/10 px-4 py-2 text-sm text-scout-green" role="status">{message}</p>}
      {actionError && <div className="mt-4"><ErrorState message={actionError} /></div>}

      <ul className="mt-6 space-y-2">
        {data.occurrences.map((o) => (
          <li key={o.id} className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Link to={`/bookings/${o.id}`} className="font-black text-scout-purple">
                  {formatLondon(o.starts_at, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                </Link>
                <p className="text-sm text-gray-600">
                  {formatLondon(o.starts_at, { timeStyle: 'short' })}–{formatLondon(o.ends_at, { timeStyle: 'short' })} · {o.resource_name} · {formatGBP(o.total_amount_pence)}
                </p>
              </div>
              <StatusBadge status={o.status} />
            </div>
            {(canCancel(o) || (admin && ACTIVE.includes(o.status))) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {admin && ACTIVE.includes(o.status) && (
                  <>
                    <button className="btn-secondary" disabled={working} onClick={() => setEditing({ booking: o, scope: 'one', start: toLondon(o.starts_at).time, end: toLondon(o.ends_at).time })}>Change this date</button>
                    <button className="btn-secondary" disabled={working} onClick={() => setEditing({ booking: o, scope: 'future', start: toLondon(o.starts_at).time, end: toLondon(o.ends_at).time })}>Change this and later</button>
                  </>
                )}
                {canCancel(o) && (
                  <>
                    <button className="btn-secondary" disabled={working} onClick={() => cancelOne(o)}>Cancel this date</button>
                    <button className="btn-secondary" disabled={working} onClick={() => cancelFuture(o)}>Cancel this and later</button>
                  </>
                )}
              </div>
            )}
            {editing?.booking.id === o.id && (
              <form
                className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-scout-off-white p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => api.put(`/admin/series/${data.id}/occurrences`, { scope: editing.scope, booking_id: o.id, start_time: editing.start, end_time: editing.end }),
                    editing.scope === 'one' ? 'The date has been changed and repriced.' : 'The dates have been changed and repriced.',
                  );
                }}
              >
                <div>
                  <label className="label" htmlFor={`am-start-${o.id}`}>New start (UK time)</label>
                  <input id={`am-start-${o.id}`} type="time" className="input" value={editing.start} onChange={(e) => setEditing({ ...editing, start: e.target.value })} required />
                </div>
                <div>
                  <label className="label" htmlFor={`am-end-${o.id}`}>New end</label>
                  <input id={`am-end-${o.id}`} type="time" className="input" value={editing.end} onChange={(e) => setEditing({ ...editing, end: e.target.value })} required />
                </div>
                <button className="btn-primary" disabled={working}>{editing.scope === 'one' ? 'Change this date' : 'Change this and later dates'}</button>
                <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <div className="card mt-6 flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold">Total for active dates</span>
        <span className="text-lg font-black text-scout-purple">{formatGBP(activeTotal)}</span>
      </div>

      {data.can_manage && data.occurrences.some((o) => canCancel(o)) && (
        <button className="btn-danger mt-6" disabled={working} onClick={cancelAll}>Cancel the whole series</button>
      )}
    </div>
  );
}
