import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorState, StatusBadge } from '../../components/ui';
import { formatGBP } from '@shared/pricing';
import { formatLondon } from '@shared/londonTime';

interface ChangeRequest {
  id: string;
  booking_id: string;
  reference: string;
  booking_status: string;
  from_resource_name: string;
  from_starts_at: string;
  from_ends_at: string;
  from_total_pence: number;
  to_resource_name: string;
  to_starts_at: string;
  to_ends_at: string;
  to_total_pence: number;
  customer_note: string | null;
  customer_name: string;
  organisation_name: string | null;
  created_at: string;
}

const range = (s: string, e: string) => `${formatLondon(s)} to ${formatLondon(e, { timeStyle: 'short' })}`;

/** Admin queue of customer change requests awaiting a decision (FR12). */
export function ChangeRequests({ onDecided }: { onDecided?: () => void }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<ChangeRequest[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api.get<ChangeRequest[]>('/admin/amendments?status=pending'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load change requests');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function decide(id: string, decision: 'approve' | 'reject') {
    setWorking(id);
    setError(null);
    try {
      await api.post(`/admin/amendments/${id}`, { decision, note: notes[id]?.trim() || null });
      await load();
      onDecided?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setWorking(null);
    }
  }

  if (!rows || rows.length === 0) return error ? <ErrorState message={error} /> : null;
  const diff = (r: ChangeRequest) => r.to_total_pence - r.from_total_pence;

  return (
    <section className="mt-6" aria-labelledby="cr-heading">
      <h2 id="cr-heading" className="text-2xl">Change requests ({rows.length})</h2>
      {error && <div className="mt-2"><ErrorState message={error} /></div>}
      <div className="mt-3 space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="card border-l-4 border-scout-yellow">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <Link to={`/bookings/${r.booking_id}`} className="font-black text-scout-purple">Ref {r.reference}</Link>
                <p className="text-sm text-gray-600">{r.customer_name}{r.organisation_name ? ` for ${r.organisation_name}` : ''} · requested {formatLondon(r.created_at, { dateStyle: 'medium' })}</p>
              </div>
              <StatusBadge status={r.booking_status} />
            </div>
            <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
              <dt className="text-gray-500">Now</dt>
              <dd>{r.from_resource_name}, {range(r.from_starts_at, r.from_ends_at)} · {formatGBP(r.from_total_pence)}</dd>
              <dt className="text-gray-500">Requested</dt>
              <dd className="font-bold">
                {r.to_resource_name}, {range(r.to_starts_at, r.to_ends_at)} · {formatGBP(r.to_total_pence)}{' '}
                <span className="font-normal text-gray-600">({diff(r) === 0 ? 'same price' : diff(r) > 0 ? `+${formatGBP(diff(r))}` : `−${formatGBP(-diff(r))}`})</span>
              </dd>
              {r.customer_note && (<><dt className="text-gray-500">Note</dt><dd>{r.customer_note}</dd></>)}
            </dl>
            {can('bookings.approve') && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div className="grow">
                  <label className="label" htmlFor={`cr-note-${r.id}`}>Message to the customer (optional)</label>
                  <input id={`cr-note-${r.id}`} className="input" maxLength={1000} value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                </div>
                <button className="btn-teal" disabled={working === r.id} onClick={() => decide(r.id, 'approve')}>Approve change</button>
                <button className="btn-danger" disabled={working === r.id} onClick={() => decide(r.id, 'reject')}>Reject</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
