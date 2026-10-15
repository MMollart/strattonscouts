import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { Spinner, EmptyState, ErrorState, StatusBadge } from '../../components/ui';
import { formatGBP } from '@shared/pricing';

interface AdminBookingRow {
  id: string;
  reference: string;
  status: string;
  starts_at: string;
  ends_at: string;
  total_amount_pence: number;
  resource_name: string;
  customer_name: string;
  customer_email: string;
}

interface ResourceRow { id: string; name: string; }

const STATUSES = ['pending_approval', 'confirmed', 'rejected', 'cancelled'];

export default function AdminBookings() {
  const { data: resources } = useApi<ResourceRow[]>('/admin/resources');
  const [status, setStatus] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdminBookingRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (resourceId) params.set('resource_id', resourceId);
    if (q.trim()) params.set('q', q.trim());
    try {
      setRows(await api.get<AdminBookingRow[]>(`/admin/bookings?${params.toString()}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load bookings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, resourceId]);

  async function decide(id: string, decision: 'approve' | 'reject') {
    setWorking(id);
    try {
      await api.post(`/admin/bookings/${id}`, { decision });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setWorking(null);
    }
  }

  async function cancel(id: string) {
    if (!confirm('Cancel this booking?')) return;
    setWorking(id);
    try {
      await api.post(`/bookings/${id}/cancel`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Bookings</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>

      <div className="card mt-6 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="f-status">Status</label>
          <select id="f-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-resource">Resource</label>
          <select id="f-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            <option value="">All resources</option>
            {resources?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <label className="label" htmlFor="f-q">Search</label>
          <input id="f-q" className="input" placeholder="Reference, name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>

      <div className="mt-6">
        {loading && <Spinner />}
        {error && <ErrorState message={error} />}
        {!loading && rows && rows.length === 0 && <EmptyState title="No bookings match these filters" />}
        {!loading && rows && rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((b) => (
              <div key={b.id} className="card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link to={`/bookings/${b.id}`} className="font-black text-scout-purple">{b.resource_name}</Link>
                    <p className="text-sm text-gray-600">{b.customer_name} · {b.customer_email}</p>
                    <p className="text-xs text-gray-500">
                      Ref {b.reference} · {new Date(b.starts_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {formatGBP(b.total_amount_pence)}
                    </p>
                  </div>
                  <StatusBadge status={b.status} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {b.status === 'pending_approval' && (
                    <>
                      <button className="btn-teal" disabled={working === b.id} onClick={() => decide(b.id, 'approve')}>Approve</button>
                      <button className="btn-danger" disabled={working === b.id} onClick={() => decide(b.id, 'reject')}>Reject</button>
                    </>
                  )}
                  {(b.status === 'confirmed' || b.status === 'pending_approval') && (
                    <button className="btn-secondary" disabled={working === b.id} onClick={() => cancel(b.id)}>Cancel</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
