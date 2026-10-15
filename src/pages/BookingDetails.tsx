import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { Spinner, ErrorState, StatusBadge } from '../components/ui';
import { formatGBP } from '@shared/pricing';
import { useAuth } from '../lib/auth';

interface BookingDetail {
  id: string;
  reference: string;
  resource_name: string;
  customer_name: string;
  customer_email?: string;
  starts_at: string;
  ends_at: string;
  status: string;
  pricing_model: string;
  unit_price_pence: number;
  total_amount_pence: number;
  created_at: string;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
}

export default function BookingDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { data, loading, error, setData } = useApi<BookingDetail>(`/bookings/${id}`, [id]);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function cancel() {
    if (!data || !confirm('Cancel this booking? This cannot be undone.')) return;
    setWorking(true);
    setActionError(null);
    try {
      await api.post(`/bookings/${data.id}/cancel`);
      setData({ ...data, status: 'cancelled' });
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not cancel booking');
    } finally {
      setWorking(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const isUpcoming = new Date(data.starts_at).getTime() > Date.now();
  const canCancel = (data.status === 'confirmed' || data.status === 'pending_approval') && (isAdmin || isUpcoming);

  return (
    <div className="mx-auto max-w-2xl">
      <button onClick={() => navigate(-1)} className="mb-4 text-sm font-bold text-scout-purple">← Back</button>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl">{data.resource_name}</h1>
          <p className="text-gray-500">Reference {data.reference}</p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <div className="card mt-6 space-y-3">
        <Row label="When" value={`${fmt(data.starts_at)} — ${fmt(data.ends_at)}`} />
        <Row label="Customer" value={data.customer_name} />
        {data.customer_email && <Row label="Email" value={data.customer_email} />}
        <Row label="Pricing model" value={data.pricing_model} />
        <Row label="Total" value={formatGBP(data.total_amount_pence)} bold />
      </div>

      {data.status === 'pending_approval' && (
        <p className="mt-4 rounded-lg bg-scout-yellow/20 px-4 py-2 text-sm text-yellow-800">
          This booking is awaiting administrator approval.
        </p>
      )}

      {actionError && <div className="mt-4"><ErrorState message={actionError} /></div>}

      {canCancel && (
        <button className="btn-danger mt-6" onClick={cancel} disabled={working}>
          {working ? 'Cancelling…' : 'Cancel booking'}
        </button>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 pb-2 last:border-0 last:pb-0">
      <span className="text-gray-500">{label}</span>
      <span className={bold ? 'text-lg font-black text-scout-purple' : 'font-bold capitalize'}>{value}</span>
    </div>
  );
}
