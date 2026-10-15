import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { useQuote } from '../../lib/useQuote';
import { PriceSummary } from '../../components/PriceSummary';
import { Spinner, EmptyState, ErrorState, StatusBadge } from '../../components/ui';
import { formatGBP } from '@shared/pricing';
import { formatLondon, londonToday } from '@shared/londonTime';
import {
  AvailabilityNotice,
  BookingWindowFields,
  type BookingWindow,
  useAvailability,
  windowToIso,
} from '../../components/BookingWindowFields';

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
  customer_phone: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
}

interface ResourceRow { id: string; name: string; is_active: boolean; }
interface CustomerRow { id: string; full_name: string; email: string; category_label: string; }

const STATUSES = ['pending_approval', 'confirmed', 'rejected', 'cancelled'];

export default function AdminBookings() {
  const { can } = useAuth();
  const { data: resources } = useApi<ResourceRow[]>('/admin/resources');
  const [status, setStatus] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdminBookingRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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

      {!can('bookings.create') ? null : creating ? (
        <BookForCustomer
          resources={(resources ?? []).filter((r) => r.is_active)}
          onClose={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await load(); }}
        />
      ) : (
        <button className="btn-primary mt-4" onClick={() => setCreating(true)}>Book for a customer</button>
      )}

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
                    <p className="text-sm text-gray-600">
                      {b.customer_name} · <a className="underline" href={`mailto:${b.customer_email}`}>{b.customer_email}</a>
                      {b.customer_phone && <> · <a className="underline" href={`tel:${b.customer_phone}`}>{b.customer_phone}</a></>}
                    </p>
                    {b.organisation_name && (
                      <p className="text-sm"><Link className="font-bold text-scout-purple" to={`/organisations/${b.organisation_id}`}>{b.organisation_name}</Link></p>
                    )}
                    <p className="text-xs text-gray-500">
                      Ref {b.reference} · {formatLondon(b.starts_at)} to {formatLondon(b.ends_at)} · {formatGBP(b.total_amount_pence)}
                    </p>
                  </div>
                  <StatusBadge status={b.status} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {b.status === 'pending_approval' && can('bookings.approve') && (
                    <>
                      <button className="btn-teal" disabled={working === b.id} onClick={() => decide(b.id, 'approve')}>Approve</button>
                      <button className="btn-danger" disabled={working === b.id} onClick={() => decide(b.id, 'reject')}>Reject</button>
                    </>
                  )}
                  {(b.status === 'confirmed' || b.status === 'pending_approval') && can('bookings.manage') && (
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

function BookForCustomer({
  resources,
  onClose,
  onCreated,
}: {
  resources: ResourceRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { data: customers, loading, error: loadError } = useApi<CustomerRow[]>('/admin/users');
  const [filter, setFilter] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const [win, setWin] = useState<BookingWindow>(() => {
    const today = londonToday();
    return { startDate: today, startTime: '10:00', endDate: today, endTime: '12:00' };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const { can } = useAuth();
  const iso = windowToIso(win);
  const availability = useAvailability(resourceId || undefined, iso);
  // Rule restrictions (FR03) can be overridden with a reason; closures and clashes cannot.
  const canOverride = can('availability.manage') && availability.status === 'restricted';
  const { quote, loading: quoting, error: quoteError } = useQuote({ resourceId: resourceId || undefined, window: customerId ? iso : null, onBehalfOfUserId: customerId || undefined });

  const matches = (customers ?? []).filter((c) =>
    `${c.full_name} ${c.email}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) return setError('Choose a customer');
    if (!iso) return setError('The end must be after the start');
    setSaving(true);
    setError(null);
    try {
      // Same validation and pricing engine as customer bookings; the price uses
      // the customer's category.
      await api.post('/bookings', {
        resource_id: resourceId,
        starts_at: iso.startsAt,
        ends_at: iso.endsAt,
        on_behalf_of_user_id: customerId,
        override: canOverride && overrideReason.trim()
          ? { kinds: availability.violations.map((v) => v.kind), reason: overrideReason.trim() }
          : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create booking');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card mt-4 space-y-4" onSubmit={submit} aria-labelledby="bfc-heading">
      <h2 id="bfc-heading" className="text-xl">Book for a customer</h2>
      {loading && <Spinner />}
      {loadError && <ErrorState message={loadError} />}
      {customers && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="bfc-filter">Find customer</label>
            <input id="bfc-filter" className="input" placeholder="Name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="bfc-customer">Customer</label>
            <select id="bfc-customer" className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Select a customer ({matches.length})</option>
              {matches.slice(0, 200).map((c) => (
                <option key={c.id} value={c.id}>{c.full_name} · {c.email} · {c.category_label}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div>
        <label className="label" htmlFor="bfc-resource">Resource</label>
        <select id="bfc-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
          {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <BookingWindowFields value={win} onChange={setWin} idPrefix="bfc" />
      <AvailabilityNotice result={availability} />
      {canOverride && (
        <div className="rounded-xl border border-scout-red/40 p-3">
          <label className="label" htmlFor="bfc-override">Override reason (recorded on the booking)</label>
          <input id="bfc-override" className="input" maxLength={500} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why this booking should go ahead anyway" />
          <p className="mt-1 text-xs text-gray-500">Leave blank to keep the restriction. Closures and clashing bookings can never be overridden.</p>
        </div>
      )}
      {customerId && <div className="rounded-xl bg-scout-off-white p-4"><PriceSummary price={quote} loading={quoting} error={quoteError} /></div>}
      <p className="text-xs text-gray-500">
        The booking is priced at the customer&apos;s category rate and follows the resource&apos;s approval setting. The customer is emailed.
      </p>
      {error && <ErrorState message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={saving || !customerId || !iso}>{saving ? 'Booking…' : 'Create booking'}</button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
