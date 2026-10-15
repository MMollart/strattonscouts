import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { Spinner, ErrorState } from '../components/ui';
import { calculateTotalPence, formatGBP } from '@shared/pricing';
import { useAuth } from '../lib/auth';

interface ResourceDetail {
  id: string;
  name: string;
  slug: string;
  pricing_model: 'hourly' | 'nightly' | 'fixed';
  requires_approval: boolean;
  prices: { category: string; label: string; amount_pence: number; is_free: boolean }[];
}

interface Category { id: string; name: string; label: string; }

function toISO(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

export default function BookResource() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: resource, loading, error } = useApi<ResourceDetail>(`/resources/${slug}`, [slug]);
  const { data: categories } = useApi<Category[]>('/categories');

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(params.get('date') ?? today);
  const [start, setStart] = useState(params.get('start') ?? '10:00');
  const [end, setEnd] = useState(params.get('end') ?? '12:00');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const myCategory = categories?.find((c) => c.id === user?.pricing_category_id);
  const myPrice = resource?.prices.find((p) => myCategory && p.category === myCategory.name);

  const [validStart, validEnd] = useMemo(() => {
    try {
      return [toISO(date, start), toISO(date, end)];
    } catch {
      return ['', ''];
    }
  }, [date, start, end]);

  const total = useMemo(() => {
    if (!resource || !myPrice || !validStart || !validEnd) return null;
    if (new Date(validEnd) <= new Date(validStart)) return null;
    return calculateTotalPence({
      pricingModel: resource.pricing_model,
      unitPricePence: myPrice.amount_pence,
      isFree: myPrice.is_free,
      startsAt: validStart,
      endsAt: validEnd,
    });
  }, [resource, myPrice, validStart, validEnd]);

  useEffect(() => setSubmitError(null), [date, start, end]);

  async function submit() {
    if (!resource) return;
    if (new Date(validEnd) <= new Date(validStart)) {
      setSubmitError('End time must be after start time');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const booking = await api.post<{ id: string }>('/bookings', {
        resource_id: resource.id,
        starts_at: validStart,
        ends_at: validEnd,
      });
      navigate(`/bookings/${booking.id}`);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : 'Could not create booking');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!resource) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl">Book {resource.name}</h1>
      {resource.requires_approval && (
        <p className="mt-2 rounded-lg bg-scout-yellow/20 px-4 py-2 text-sm text-yellow-800">
          This resource requires administrator approval. You will receive a confirmation once approved.
        </p>
      )}

      <div className="card mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="date">Date</label>
          <input id="date" type="date" min={today} className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="start">Start time</label>
            <input id="start" type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="end">End time</label>
            <input id="end" type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <div className="rounded-xl bg-scout-off-white p-4">
          <div className="flex items-center justify-between">
            <span>Your category</span>
            <span className="font-bold">{myCategory?.label ?? '—'}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-lg">
            <span>Estimated total</span>
            <span className="font-black text-scout-purple">{total !== null ? formatGBP(total) : '—'}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">The final price is confirmed server-side when you submit.</p>
        </div>

        {submitError && <ErrorState message={submitError} />}

        <button className="btn-primary w-full" onClick={submit} disabled={submitting || total === null}>
          {submitting ? 'Submitting…' : resource.requires_approval ? 'Request booking' : 'Confirm booking'}
        </button>
      </div>
    </div>
  );
}
