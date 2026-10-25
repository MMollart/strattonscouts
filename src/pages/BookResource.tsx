import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, ErrorState } from '../components/ui';
import { useAuth } from '../lib/auth';
import { addDays, formatLondon, londonToday, toLondon } from '@shared/londonTime';
import { useBasket } from '../lib/basket';
import { hierarchyRelation } from '@shared/hierarchy';
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
import { useRequiredAgreements } from '../components/AgreementAcceptance';

interface ResourceDetail {
  id: string;
  name: string;
  slug: string;
  pricing_model: 'hourly' | 'nightly' | 'fixed';
  requires_approval: boolean;
  provisional_hold_hours: number;
  min_nights?: number | null;
  default_start_time?: string | null;
  default_end_time?: string | null;
  prices: { category: string; label: string; amount_pence: number; is_free: boolean }[];
}

interface Category { id: string; name: string; label: string; }

interface ResourceOpt { id: string; name: string; ancestor_ids: string[] }

function toWindow(start: string, end: string): BookingWindow {
  const s = toLondon(start);
  const e = toLondon(end);
  return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

/** A time picked on the calendar, else the time of the booking being put together, else today. */
function initialWindow(params: URLSearchParams, basketWindow: { startsAt: string; endsAt: string } | null): BookingWindow {
  const start = params.get('start');
  const end = params.get('end');
  if (start && end && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end))) return toWindow(start, end);
  if (basketWindow) return toWindow(basketWindow.startsAt, basketWindow.endsAt);
  const today = londonToday();
  return { startDate: today, startTime: '10:00', endDate: today, endTime: '12:00' };
}

export default function BookResource() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const basket = useBasket();
  const { data: allResources } = useApi<ResourceOpt[]>('/resources');
  const { data: resource, loading, error } = useApi<ResourceDetail>(`/resources/${slug}`, [slug]);
  const { data: categories } = useApi<Category[]>('/categories');
  const { data: organisations } = useApi<MyOrganisation[]>('/organisations');
  const [organisationId, setOrganisationId] = useState<string>(() => params.get('organisation') ?? '');
  const organisation = organisations?.find((o) => o.id === organisationId);

  const [win, setWin] = useState<BookingWindow>(() => initialWindow(params, basket.resourceIds.length ? basket.window : null));
  const [repeat, setRepeat] = useState(false);
  const [added, setAdded] = useState(false);
  const { agreements } = useRequiredAgreements(resource && repeat ? [resource.id] : []);

  const myCategory = categories?.find((c) => c.id === (organisation ? organisation.pricing_category_id : user?.pricing_category_id));
  const iso = useMemo(() => windowToIso(win), [win]);
  const availability = useAvailability(resource?.id, iso);

  const { quote, loading: quoting, error: quoteError } = useQuote({ resourceId: resource?.id, window: iso, organisationId: organisation?.id ?? null });

  useEffect(() => setAdded(false), [win]);

  // Unless a time was picked on the calendar or a booking is under way, start
  // from the resource's usual arrival and departure times, ending the next day
  // (or after its minimum nights) for nightly resources such as Camping.
  useEffect(() => {
    if (!resource || (params.get('start') && params.get('end')) || basket.resourceIds.length) return;
    const nights = resource.pricing_model === 'nightly' ? Math.max(1, resource.min_nights ?? 1) : 0;
    setWin((w) => ({
      ...w,
      startTime: resource.default_start_time ?? w.startTime,
      endDate: addDays(w.startDate, nights),
      endTime: resource.default_end_time ?? w.endTime,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.id]);

  const inBasket = !!resource && basket.resourceIds.includes(resource.id);
  const others = basket.resourceIds.filter((id) => id !== resource?.id);
  const byId = new Map((allResources ?? []).map((r) => [r.id, r]));
  const nameOf = (id: string) => byId.get(id)?.name ?? 'a resource';
  // A resource cannot be booked with one it is part of (a hall and the Whole Venue).
  const clash = resource
    ? others.map((id) => [id, hierarchyRelation(resource.id, id, (x) => byId.get(x)?.ancestor_ids ?? [])] as const).find(([, rel]) => rel)
    : undefined;
  const timeChanges = !!iso && others.length > 0 && !!basket.window && (basket.window.startsAt !== iso.startsAt || basket.window.endsAt !== iso.endsAt);
  const blocked = ['conflict', 'closure', 'inactive', 'restricted'].includes(availability.status);

  function addToBooking() {
    if (!resource || !iso) return;
    basket.add(resource.id, iso);
    setAdded(true);
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
          <RecurringBooking resourceId={resource.id} resourceName={resource.name} organisationId={organisation?.id ?? null} window={win} agreements={agreements} />
        ) : (
        <div className="space-y-3 border-t border-gray-100 pt-4">
          {others.length > 0 && basket.window && (
            <p className="text-sm text-gray-600">
              Your booking so far: {others.map(nameOf).join(', ')}, {formatLondon(basket.window.startsAt)} to {formatLondon(basket.window.endsAt)}.
            </p>
          )}
          {timeChanges && (
            <p className="rounded-lg bg-scout-yellow/20 px-3 py-2 text-sm text-yellow-900">
              This is a different time from the rest of your booking. Adding it moves everything in your booking to this time; you can check each
              resource at checkout.
            </p>
          )}
          {clash && (
            <p className="rounded-lg bg-scout-red/10 px-3 py-2 text-sm text-scout-red" role="alert">
              {clash[1] === 'parent'
                ? `${resource.name} is part of ${nameOf(clash[0])}, which is already in your booking.`
                : `${resource.name} includes ${nameOf(clash[0])}, which is already in your booking. Remove it at checkout to book this instead.`}
            </p>
          )}
          {added || (inBasket && !timeChanges) ? (
            <div className="rounded-xl bg-scout-green/10 p-4" role="status">
              <p className="font-bold text-scout-green">{resource.name} is in your booking.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to="/resources" className="btn-secondary">Add another resource</Link>
                <Link to="/checkout" className="btn-primary">Review and book ({basket.resourceIds.length})</Link>
              </div>
            </div>
          ) : (
            <button className="btn-primary w-full" onClick={addToBooking} disabled={!iso || !quote || blocked || !!clash}>
              {inBasket ? 'Update the time in my booking' : 'Add to booking'}
            </button>
          )}
          <p className="text-xs text-gray-500">
            Add every resource you need for this time, then review and send them together as one booking.
          </p>
        </div>
        )}
      </div>
    </div>
  );
}
