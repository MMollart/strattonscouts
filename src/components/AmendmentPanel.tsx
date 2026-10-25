import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { ErrorState } from './ui';
import { BookingWindowFields, type BookingWindow, windowToIso } from './BookingWindowFields';
import { PriceSummary } from './PriceSummary';
import { formatGBP, type PriceBreakdown } from '@shared/pricing';
import { AgreementAcceptance, type AcceptanceValue, type RequiredAgreement } from './AgreementAcceptance';
import { formatLondon, londonToday, toLondon } from '@shared/londonTime';

interface Amendment {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  from_resource_name: string;
  from_starts_at: string;
  from_ends_at: string;
  from_total_pence: number;
  to_resource_name: string;
  to_starts_at: string;
  to_ends_at: string;
  to_total_pence: number;
  customer_note: string | null;
  decision_note: string | null;
  created_at: string;
  requested_by_name: string;
}

interface Quote {
  price: PriceBreakdown;
  current_total_pence: number;
  difference_pence: number;
  /** Agreements this change brings in that the booking has not accepted (FR20). */
  agreements_required: RequiredAgreement[];
}

const AMENDMENT_BADGE: Record<Amendment['status'], [string, string]> = {
  pending: ['waiting for approval', 'bg-scout-yellow/30 text-yellow-800'],
  approved: ['approved', 'bg-scout-green/15 text-scout-green'],
  rejected: ['not approved', 'bg-scout-red/15 text-scout-red'],
  withdrawn: ['withdrawn', 'bg-gray-200 text-gray-600'],
};

function range(startsAt: string, endsAt: string) {
  return `${formatLondon(startsAt)} to ${formatLondon(endsAt, { timeStyle: 'short' })}`;
}

/**
 * Request a change to a booking and see past requests (FR12). Every request is
 * reviewed by an administrator; the original booking stays in place until then.
 */
export function AmendmentPanel({
  booking,
  canRequest,
}: {
  booking: { id: string; resource_id: string; starts_at: string; ends_at: string; resources?: { resource_id: string }[] };
  canRequest: boolean;
}) {
  const { data: history, setData: setHistory } = useApi<Amendment[]>(`/bookings/${booking.id}/amendments`, [booking.id]);
  const { data: resources } = useApi<{ id: string; name: string }[]>('/resources');
  const [open, setOpen] = useState(false);
  // The resources the booking should hold after the change.
  const [resourceIds, setResourceIds] = useState<string[]>(() =>
    booking.resources?.length ? booking.resources.map((r) => r.resource_id) : [booking.resource_id],
  );
  const toggleResource = (id: string) =>
    setResourceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const requested = () => ({ resource_id: resourceIds[0], resource_ids: resourceIds });
  const [win, setWin] = useState<BookingWindow>(() => {
    const s = toLondon(booking.starts_at);
    const e = toLondon(booking.ends_at);
    return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
  });
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [acceptance, setAcceptance] = useState<AcceptanceValue | null>(null);
  const iso = windowToIso(win);
  const pending = history?.find((a) => a.status === 'pending');

  useEffect(() => {
    setQuote(null);
    setError(null);
  }, [resourceIds, win]);

  async function reload() {
    setHistory(await api.get<Amendment[]>(`/bookings/${booking.id}/amendments`));
  }

  async function check() {
    if (!iso) return setError('The end must be after the start');
    if (!resourceIds.length) return setError('Choose at least one resource');
    setWorking(true);
    setError(null);
    try {
      setQuote(await api.post<Quote>(`/bookings/${booking.id}/amendments/quote`, { ...requested(), starts_at: iso.startsAt, ends_at: iso.endsAt }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not check this change');
    } finally {
      setWorking(false);
    }
  }

  async function submit() {
    if (!iso) return;
    setWorking(true);
    setError(null);
    try {
      await api.post(`/bookings/${booking.id}/amendments`, { ...requested(), starts_at: iso.startsAt, ends_at: iso.endsAt, note: note.trim() || null, agreements: quote?.agreements_required.length ? acceptance : null });
      setOpen(false);
      setQuote(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the request');
    } finally {
      setWorking(false);
    }
  }

  async function withdraw(id: string) {
    if (!confirm('Withdraw this change request? Your booking stays as it is.')) return;
    try {
      await api.del(`/bookings/${booking.id}/amendments/${id}`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not withdraw the request');
    }
  }

  return (
    <section className="mt-6" aria-labelledby="amend-heading">
      <h2 id="amend-heading" className="text-xl">Changes</h2>

      {pending && (
        <div className="card mt-3 border-l-4 border-scout-yellow">
          <p className="font-bold">Change requested: waiting for approval</p>
          <p className="text-sm text-gray-700">
            {pending.to_resource_name}, {range(pending.to_starts_at, pending.to_ends_at)} · {formatGBP(pending.to_total_pence)}
          </p>
          <p className="text-xs text-gray-500">Your current booking stays reserved until an administrator decides.</p>
          {canRequest && <button type="button" className="btn-secondary mt-2" onClick={() => withdraw(pending.id)}>Withdraw request</button>}
        </div>
      )}

      {canRequest && !pending && !open && (
        <button type="button" className="btn-secondary mt-3" onClick={() => setOpen(true)}>Request a change</button>
      )}

      {open && (
        <div className="card mt-3 space-y-4">
          <fieldset>
            <legend className="label">Resources</legend>
            <p className="mb-2 text-xs text-gray-500">Tick every resource the booking should include. Add or remove resources, or change the time below.</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {(resources ?? []).map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={resourceIds.includes(r.id)} onChange={() => toggleResource(r.id)} />
                  {r.name}
                </label>
              ))}
            </div>
          </fieldset>
          <BookingWindowFields value={win} onChange={setWin} idPrefix="am" minDate={londonToday()} />
          <div>
            <label className="label" htmlFor="am-note">Note for the administrator (optional)</label>
            <textarea id="am-note" className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {quote && (
            <div className="rounded-xl bg-scout-off-white p-4">
              <p className="mb-2 font-bold text-scout-green">This time is available.</p>
              <PriceSummary price={quote.price} />
              <p className="mt-2 text-sm">
                Currently {formatGBP(quote.current_total_pence)}:{' '}
                <span className="font-bold">
                  {quote.difference_pence === 0 ? 'no change in price' : quote.difference_pence > 0 ? `${formatGBP(quote.difference_pence)} more` : `${formatGBP(-quote.difference_pence)} less`}
                </span>
              </p>
            </div>
          )}
          {quote && quote.agreements_required.length > 0 && (
            <AgreementAcceptance agreements={quote.agreements_required} onChange={setAcceptance} idPrefix="am-agr" />
          )}
          {error && <ErrorState message={error} />}
          <div className="flex flex-wrap gap-2">
            {!quote
              ? <button type="button" className="btn-primary" onClick={check} disabled={working || !iso}>{working ? 'Checking…' : 'Check availability and price'}</button>
              : <button type="button" className="btn-primary" onClick={submit} disabled={working || (quote.agreements_required.length > 0 && !acceptance)}>{working ? 'Sending…' : 'Send change request'}</button>}
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <p className="text-xs text-gray-500">All changes are approved by an administrator. Your current booking is kept until then.</p>
        </div>
      )}

      {history && history.filter((a) => a.status !== 'pending').length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {history.filter((a) => a.status !== 'pending').map((a) => (
            <li key={a.id} className="card py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Requested {formatLondon(a.created_at, { dateStyle: 'medium' })} by {a.requested_by_name}</span>
                <span className={`badge ${AMENDMENT_BADGE[a.status][1]}`}>{AMENDMENT_BADGE[a.status][0]}</span>
              </div>
              <p className="text-gray-600">From {a.from_resource_name}, {range(a.from_starts_at, a.from_ends_at)} ({formatGBP(a.from_total_pence)})</p>
              <p className="text-gray-600">To {a.to_resource_name}, {range(a.to_starts_at, a.to_ends_at)} ({formatGBP(a.to_total_pence)})</p>
              {a.decision_note && <p className="text-gray-600">Note: {a.decision_note}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
