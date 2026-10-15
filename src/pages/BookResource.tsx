import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { Spinner, ErrorState } from '../components/ui';
import { calculateTotalPence, formatGBP } from '@shared/pricing';
import { useAuth } from '../lib/auth';
import { londonToday, toLondon } from '@shared/londonTime';
import {
  AVAILABILITY_MESSAGE,
  BookingWindowFields,
  type BookingWindow,
  useAvailability,
  windowToIso,
} from '../components/BookingWindowFields';

interface ResourceDetail {
  id: string;
  name: string;
  slug: string;
  pricing_model: 'hourly' | 'nightly' | 'fixed';
  requires_approval: boolean;
  prices: { category: string; label: string; amount_pence: number; is_free: boolean }[];
}

interface Category { id: string; name: string; label: string; }

function initialWindow(params: URLSearchParams): BookingWindow {
  const start = params.get('start');
  const end = params.get('end');
  if (start && end && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end))) {
    const s = toLondon(start);
    const e = toLondon(end);
    return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
  }
  const today = londonToday();
  return { startDate: today, startTime: '10:00', endDate: today, endTime: '12:00' };
}

export default function BookResource() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: resource, loading, error } = useApi<ResourceDetail>(`/resources/${slug}`, [slug]);
  const { data: categories } = useApi<Category[]>('/categories');

  const [win, setWin] = useState<BookingWindow>(() => initialWindow(params));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const myCategory = categories?.find((c) => c.id === user?.pricing_category_id);
  const myPrice = resource?.prices.find((p) => myCategory && p.category === myCategory.name);
  const iso = useMemo(() => windowToIso(win), [win]);
  const availability = useAvailability(resource?.id, iso);

  const total = useMemo(() => {
    if (!resource || !myPrice || !iso) return null;
    return calculateTotalPence({
      pricingModel: resource.pricing_model,
      unitPricePence: myPrice.amount_pence,
      isFree: myPrice.is_free,
      startsAt: iso.startsAt,
      endsAt: iso.endsAt,
    });
  }, [resource, myPrice, iso]);

  useEffect(() => setSubmitError(null), [win]);

  async function submit() {
    if (!resource) return;
    if (!iso) {
      setSubmitError('The end must be after the start');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const booking = await api.post<{ id: string }>('/bookings', {
        resource_id: resource.id,
        starts_at: iso.startsAt,
        ends_at: iso.endsAt,
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
        <BookingWindowFields value={win} onChange={setWin} minDate={londonToday()} />
        {!iso && <p className="text-sm text-scout-red">The end must be after the start.</p>}
        {availability !== 'idle' && (
          <p
            className={`text-sm font-bold ${availability === 'available' ? 'text-scout-green' : availability === 'checking' ? 'text-gray-500' : 'text-scout-red'}`}
            role="status"
          >
            {AVAILABILITY_MESSAGE[availability]}
          </p>
        )}

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

        <button className="btn-primary w-full" onClick={submit} disabled={submitting || total === null || availability === 'conflict' || availability === 'closure' || availability === 'inactive'}>
          {submitting ? 'Submitting…' : resource.requires_approval ? 'Request booking' : 'Confirm booking'}
        </button>
      </div>
    </div>
  );
}
