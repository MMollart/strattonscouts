import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { Spinner, ErrorState } from '../components/ui';
import { useAuth } from '../lib/auth';
import { londonToday, toLondon } from '@shared/londonTime';
import {
  AvailabilityNotice,
  BookingWindowFields,
  type BookingWindow,
  useAvailability,
  windowToIso,
} from '../components/BookingWindowFields';
import type { MyOrganisation } from './Organisations';
import { useQuote } from '../lib/useQuote';
import { PriceSummary } from '../components/PriceSummary';
import { RecurringBooking } from '../components/RecurringBooking';
import { ExtraResources, type ExtraStatus } from '../components/ExtraResources';
import { formatGBP } from '@shared/pricing';

interface ResourceDetail {
  id: string;
  name: string;
  slug: string;
  pricing_model: 'hourly' | 'nightly' | 'fixed';
  requires_approval: boolean;
  provisional_hold_hours: number;
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
  const { data: organisations } = useApi<MyOrganisation[]>('/organisations');
  const [organisationId, setOrganisationId] = useState<string>(() => params.get('organisation') ?? '');
  const organisation = organisations?.find((o) => o.id === organisationId);

  const [win, setWin] = useState<BookingWindow>(() => initialWindow(params));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [provisional, setProvisional] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [extras, setExtras] = useState<string[]>([]);
  const [extraStatus, setExtraStatus] = useState<Record<string, ExtraStatus | null>>({});

  const myCategory = categories?.find((c) => c.id === (organisation ? organisation.pricing_category_id : user?.pricing_category_id));
  const iso = useMemo(() => windowToIso(win), [win]);
  const availability = useAvailability(resource?.id, iso);

  const { quote, loading: quoting, error: quoteError } = useQuote({ resourceId: resource?.id, window: iso, organisationId: organisation?.id ?? null });

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
        ...(extras.length ? { additional_resource_ids: extras } : {}),
        starts_at: iso.startsAt,
        ends_at: iso.endsAt,
        organisation_id: organisation?.id ?? null,
        provisional,
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

  const extrasReady = extras.every((id) => extraStatus[id]?.ok);
  const groupTotal = quote && extrasReady ? extras.reduce((sum, id) => sum + (extraStatus[id]?.totalPence ?? 0), quote.total_pence) : null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl">Book {resource.name}</h1>
      {resource.requires_approval && (
        <p className="mt-2 rounded-lg bg-scout-yellow/20 px-4 py-2 text-sm text-yellow-800">
          This resource requires administrator approval. You will receive a confirmation once approved.
        </p>
      )}

      <div className="card mt-6 space-y-4">
        {organisations && organisations.length > 0 && (
          <div>
            <label className="label" htmlFor="book-as">Booking for</label>
            <select id="book-as" className="input" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
              <option value="">Myself (personal booking)</option>
              {organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            {organisation && <p className="mt-1 text-xs text-gray-500">Priced at {organisation.name}&apos;s rates and visible to its members.</p>}
          </div>
        )}
        <BookingWindowFields value={win} onChange={setWin} minDate={londonToday()} />
        {!iso && <p className="text-sm text-scout-red">The end must be after the start.</p>}
        <AvailabilityNotice result={availability} />

        <div className="rounded-xl bg-scout-off-white p-4">
          <div className="flex items-center justify-between">
            <span>{organisation ? 'Organisation category' : 'Your category'}</span>
            <span className="font-bold">{myCategory?.label ?? '—'}</span>
          </div>
          <div className="mt-3">
            <PriceSummary price={quote} loading={quoting} error={quoteError} />
          </div>
          <p className="mt-2 text-xs text-gray-500">This is the price you will be charged; it is fixed when you submit.</p>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          <span className="font-bold">Repeat this booking</span>
        </label>

        {repeat ? (
          <RecurringBooking resourceId={resource.id} resourceName={resource.name} organisationId={organisation?.id ?? null} window={win} />
        ) : (
        <>
        <ExtraResources
          mainResourceId={resource.id}
          window={iso}
          organisationId={organisation?.id ?? null}
          selected={extras}
          onChange={setExtras}
          onStatus={(id, st) => setExtraStatus((prev) => ({ ...prev, [id]: st }))}
        />
        {extras.length > 0 && (
          <p className="flex justify-between rounded-xl bg-scout-off-white p-4 font-bold">
            <span>Total for {extras.length + 1} resources</span>
            <span>{groupTotal === null ? '—' : formatGBP(groupTotal)}</span>
          </p>
        )}

        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} />
          <span>
            <span className="font-bold">Hold this time provisionally</span>
            <span className="block text-sm text-gray-600">
              We reserve it for up to {resource.provisional_hold_hours} hours (never past the start of the booking). It is released
              automatically unless an administrator confirms it in that time.
            </span>
          </span>
        </label>

        {submitError && <ErrorState message={submitError} />}

        <button className="btn-primary w-full" onClick={submit} disabled={submitting || !quote || !extrasReady || ['conflict', 'closure', 'inactive', 'restricted'].includes(availability.status)}>
          {submitting ? 'Submitting…' : provisional ? 'Hold provisionally' : resource.requires_approval ? 'Request booking' : 'Confirm booking'}
          {extras.length > 0 && !submitting ? ` (${extras.length + 1} resources)` : ''}
        </button>
        </>
        )}
      </div>
    </div>
  );
}
