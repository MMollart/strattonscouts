import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useBasket } from '../lib/basket';
import { useQuote } from '../lib/useQuote';
import { EmptyState, ErrorState } from '../components/ui';
import { AvailabilityNotice, BookingWindowFields, type BookingWindow, useAvailability, windowToIso } from '../components/BookingWindowFields';
import { AgreementAcceptance, useRequiredAgreements, type AcceptanceValue, type RequiredAgreement } from '../components/AgreementAcceptance';
import { PriceSummary } from '../components/PriceSummary';
import { formatGBP } from '@shared/pricing';
import { londonToday, toLondon } from '@shared/londonTime';
import type { MyOrganisation } from './Organisations';

interface ResourceOpt { id: string; name: string; slug: string; requires_approval: boolean }

const UNAVAILABLE = ['conflict', 'closure', 'inactive', 'restricted'];

/**
 * Checkout: everything added with "Add to booking", for one time, sent as
 * one booking. Each resource is checked and priced live; the server books
 * all of them or none.
 */
export default function Checkout() {
  const basket = useBasket();
  const navigate = useNavigate();
  const { data: resources } = useApi<ResourceOpt[]>('/resources');
  const { data: organisations } = useApi<MyOrganisation[]>('/organisations');
  const [organisationId, setOrganisationId] = useState('');
  const organisation = organisations?.find((o) => o.id === organisationId);
  const [win, setWin] = useState<BookingWindow | null>(() => {
    if (!basket.window) return null;
    const s = toLondon(basket.window.startsAt);
    const e = toLondon(basket.window.endsAt);
    return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
  });
  const iso = useMemo(() => (win ? windowToIso(win) : null), [win]);
  const [status, setStatus] = useState<Record<string, { ok: boolean; totalPence: number | null }>>({});
  const [provisional, setProvisional] = useState(false);
  const [acceptance, setAcceptance] = useState<AcceptanceValue | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { agreements, setAgreements } = useRequiredAgreements(basket.resourceIds);
  const agreed = !!agreements && (agreements.length === 0 || !!acceptance);

  // Changing the time here changes it for everything in the booking.
  useEffect(() => {
    if (iso && (iso.startsAt !== basket.window?.startsAt || iso.endsAt !== basket.window?.endsAt)) basket.setWindow(iso);
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso?.startsAt, iso?.endsAt]);

  const byId = new Map((resources ?? []).map((r) => [r.id, r]));
  const items = basket.resourceIds;
  const ready = items.length > 0 && items.every((id) => status[id]?.ok);
  const total = ready ? items.reduce((n, id) => n + (status[id]?.totalPence ?? 0), 0) : null;
  const needsApproval = items.some((id) => byId.get(id)?.requires_approval);

  async function submit() {
    if (!iso || !items.length) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const booking = await api.post<{ id: string }>('/bookings', {
        resource_id: items[0],
        additional_resource_ids: items.slice(1),
        starts_at: iso.startsAt,
        ends_at: iso.endsAt,
        organisation_id: organisation?.id ?? null,
        provisional,
        agreements: agreements?.length ? acceptance : null,
      });
      basket.clear();
      navigate(`/bookings/${booking.id}`);
    } catch (e) {
      // A newer version of an agreement came into effect: show it to accept.
      if (e instanceof ApiError && e.code === 'agreements_required') setAgreements((e.details as { required: RequiredAgreement[] }).required);
      setSubmitError(e instanceof ApiError ? e.message : 'Could not create the booking');
    } finally {
      setSubmitting(false);
    }
  }

  if (!items.length || !win) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl">Your booking</h1>
        <div className="mt-6">
          <EmptyState title="Nothing in your booking yet">
            Choose a <Link to="/resources" className="font-bold text-scout-purple">resource</Link>, pick a time and select Add to booking.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl">Review your booking</h1>
      <p className="mt-2 text-gray-600">Everything here is booked together, for the same time, as one booking with one reference.</p>

      <div className="card mt-6 space-y-4">
        {organisations && organisations.length > 0 && (
          <div>
            <label className="label" htmlFor="co-as">Booking for</label>
            <select id="co-as" className="input" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
              <option value="">Myself (personal booking)</option>
              {organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            {organisation && <p className="mt-1 text-xs text-gray-500">Priced at {organisation.name}&apos;s rates and visible to its members.</p>}
          </div>
        )}
        <BookingWindowFields value={win} onChange={setWin} minDate={londonToday()} idPrefix="co" />
        {!iso && <p className="text-sm text-scout-red">The end must be after the start.</p>}
      </div>

      <section className="mt-6 space-y-3" aria-labelledby="co-items">
        <h2 id="co-items" className="text-xl">Resources</h2>
        {items.map((id) => (
          <Item
            key={id}
            resourceId={id}
            name={byId.get(id)?.name ?? 'Resource'}
            needsApproval={!!byId.get(id)?.requires_approval}
            window={iso}
            organisationId={organisation?.id ?? null}
            onStatus={(st) => setStatus((prev) => (prev[id]?.ok === st.ok && prev[id]?.totalPence === st.totalPence ? prev : { ...prev, [id]: st }))}
            onRemove={() => basket.remove(id)}
          />
        ))}
        <Link to="/resources" className="inline-block text-sm font-bold text-scout-purple">+ Add another resource</Link>
      </section>

      <div className="card mt-6 space-y-4">
        <p className="flex justify-between text-lg font-bold">
          <span>Total for {items.length} resource{items.length === 1 ? '' : 's'}</span>
          <span className="text-scout-purple">{total === null ? '—' : formatGBP(total)}</span>
        </p>
        {needsApproval && (
          <p className="rounded-lg bg-scout-yellow/20 px-4 py-2 text-sm text-yellow-800">
            Some of these resources need administrator approval, so the whole booking will wait for approval. You will receive a confirmation once approved.
          </p>
        )}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} />
          <span>
            <span className="font-bold">Hold this time provisionally</span>
            <span className="block text-sm text-gray-600">
              We reserve it for a limited time (never past the start of the booking). It is released automatically unless an administrator confirms it.
            </span>
          </span>
        </label>
        {agreements && <AgreementAcceptance agreements={agreements} onChange={setAcceptance} idPrefix="co-agr" />}
        {submitError && <ErrorState message={submitError} />}
        <button className="btn-primary w-full" onClick={submit} disabled={submitting || !iso || !ready || !agreed}>
          {submitting ? 'Submitting…' : provisional ? 'Hold provisionally' : needsApproval ? 'Request booking' : 'Confirm booking'}
        </button>
        <button type="button" className="w-full text-sm font-bold text-scout-purple" onClick={() => { if (confirm('Remove everything from your booking?')) basket.clear(); }}>
          Clear booking
        </button>
      </div>
    </div>
  );
}

/** One resource in the booking: its availability and price for the chosen time. */
function Item({
  resourceId, name, needsApproval, window, organisationId, onStatus, onRemove,
}: {
  resourceId: string;
  name: string;
  needsApproval: boolean;
  window: { startsAt: string; endsAt: string } | null;
  organisationId: string | null;
  onStatus: (s: { ok: boolean; totalPence: number | null }) => void;
  onRemove: () => void;
}) {
  const availability = useAvailability(resourceId, window);
  const { quote, loading, error } = useQuote({ resourceId, window, organisationId });
  const ok = availability.status === 'available' && !!quote;
  useEffect(() => onStatus({ ok, totalPence: quote?.total_pence ?? null }), [ok, quote?.total_pence]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`card space-y-2 ${UNAVAILABLE.includes(availability.status) ? 'border-scout-red/40' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-black">{name}</p>
          {needsApproval && <p className="text-xs text-yellow-800">Needs approval</p>}
        </div>
        <button type="button" className="text-sm font-bold text-scout-purple" onClick={onRemove}>Remove</button>
      </div>
      <AvailabilityNotice result={availability} />
      <PriceSummary price={quote} loading={loading} error={error} />
    </div>
  );
}
