import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, EmptyState, ErrorState } from '../../components/ui';
import { ChangeTable, actorText, type AuditEventView } from '../../components/HistoryPanel';
import { formatLondon } from '@shared/londonTime';
import { ACTION_AREAS, ENTITY_TYPE_LABELS, actionLabel } from '@shared/audit';

interface Filters {
  from: string;
  to: string;
  actor_id: string;
  actor_type: string;
  organisation_id: string;
  entity_type: string;
  action: string;
  booking_reference: string;
  q: string;
}

const EMPTY: Filters = { from: '', to: '', actor_id: '', actor_type: '', organisation_id: '', entity_type: '', action: '', booking_reference: '', q: '' };

interface Integrity {
  ok: boolean;
  checked: number;
  unsealed: number;
  broken_at?: { seq: number; id: string; created_at: string };
  head_hash: string | null;
}

/** Admin > Audit history (FR11 §6.4): search, review and export significant changes. */
export default function AdminAudit() {
  const { can } = useAuth();
  const { data: orgs } = useApi<{ id: string; name: string }[]>('/admin/organisations');
  const { data: users } = useApi<{ id: string; full_name: string; email: string }[]>('/admin/users');
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [access, setAccess] = useState<'full' | 'restricted'>('full');
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [checking, setChecking] = useState(false);

  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();

  async function load(before?: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ access: 'full' | 'restricted'; events: AuditEventView[]; next_before: number | null }>(
        `/admin/audit?${query}${before ? `&before=${before}` : ''}`,
      );
      setAccess(res.access);
      setEvents((prev) => (before && prev ? [...prev, ...res.events] : res.events));
      setNext(res.next_before);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the audit history');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function checkIntegrity() {
    setChecking(true);
    try {
      setIntegrity(await api.post<Integrity>('/admin/audit/verify', {}));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not check the audit history');
    } finally {
      setChecking(false);
    }
  }

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl">Audit history</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>
      <p className="mt-2 text-sm text-gray-600">
        Every significant change to bookings, prices, resources, users, organisations, assets, maintenance and agreements, with who made it and when.
        {access === 'restricted' && ' As a Viewer you can see who changed what and when, but not the values or reasons.'}
      </p>

      <form
        className="card mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <div>
          <label className="label" htmlFor="au-from">From</label>
          <input id="au-from" type="date" className="input" value={draft.from} onChange={set('from')} />
        </div>
        <div>
          <label className="label" htmlFor="au-to">To</label>
          <input id="au-to" type="date" className="input" value={draft.to} onChange={set('to')} />
        </div>
        <div>
          <label className="label" htmlFor="au-area">Action</label>
          <select id="au-area" className="input" value={draft.action} onChange={set('action')}>
            <option value="">Any action</option>
            {ACTION_AREAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-type">Record type</label>
          <select id="au-type" className="input" value={draft.entity_type} onChange={set('entity_type')}>
            <option value="">Any record</option>
            {Object.entries(ENTITY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-user">Changed by</label>
          <select id="au-user" className="input" value={draft.actor_id} onChange={set('actor_id')}>
            <option value="">Anyone</option>
            {users?.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-actor">Actor type</label>
          <select id="au-actor" className="input" value={draft.actor_type} onChange={set('actor_type')}>
            <option value="">Any</option>
            <option value="administrator">Administrator</option>
            <option value="customer">Customer</option>
            <option value="system">System (automatic)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-org">Organisation</label>
          <select id="au-org" className="input" value={draft.organisation_id} onChange={set('organisation_id')}>
            <option value="">Any organisation</option>
            {orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-ref">Booking reference</label>
          <input id="au-ref" className="input" placeholder="SS-…" value={draft.booking_reference} onChange={set('booking_reference')} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="au-q">Search</label>
          <input id="au-q" className="input" placeholder="Record name, person or organisation" value={draft.q} onChange={set('q')} />
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <button className="btn-primary">Search</button>
          <button type="button" className="btn-secondary" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); }}>Clear</button>
          {can('audit.export') && (
            <a className="btn-secondary" href={`/api/admin/audit/export?${query}`}>Export CSV</a>
          )}
        </div>
      </form>

      {can('audit.view') && (
        <div className="card mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-bold">Tamper check</p>
            {!integrity && <p className="text-gray-600">Recomputes the hash chain over every record to confirm none has been altered or removed since it was sealed.</p>}
            {integrity?.ok && <p className="text-scout-green">All {integrity.checked} sealed records match the chain{integrity.unsealed ? ` (${integrity.unsealed} awaiting sealing)` : ''}.</p>}
            {integrity && !integrity.ok && (
              <p className="text-scout-red" role="alert">
                The record made {formatLondon(integrity.broken_at!.created_at)} (no. {integrity.broken_at!.seq}) does not match the chain. It, or one before it, was changed outside the application.
              </p>
            )}
          </div>
          <button className="btn-secondary" disabled={checking} onClick={() => void checkIntegrity()}>{checking ? 'Checking…' : 'Check integrity'}</button>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {error && <ErrorState message={error} />}
        {events && events.length === 0 && !loading && <EmptyState title="No matching changes" />}
        {events?.map((e) => (
          <article key={e.id} className="card py-3">
            <button className="flex w-full flex-wrap items-start justify-between gap-2 text-left" aria-expanded={expanded === e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
              <div>
                <p className="font-bold">
                  {actionLabel(e.action)}
                  {e.entity_label && <span className="font-normal text-gray-700"> · {e.entity_label}</span>}
                </p>
                <p className="text-xs text-gray-600">
                  {ENTITY_TYPE_LABELS[e.entity_type] ?? e.entity_type}
                  {e.booking_reference && ` · ${e.booking_reference}`}
                  {e.organisation_name && ` · ${e.organisation_name}`}
                </p>
              </div>
              <div className="text-right text-xs text-gray-600">
                <p>{formatLondon(e.created_at)}</p>
                <p>{actorText(e)}</p>
              </div>
            </button>
            {expanded === e.id && (
              <div className="mt-2 border-t border-gray-100 pt-2 text-sm">
                {e.reason && <p>Reason: {e.reason}</p>}
                <ChangeTable before={e.before} after={e.after} />
                {access === 'full' && !e.before && !e.after && <p className="text-xs text-gray-500">No values recorded for this change.</p>}
                <p className="mt-2 text-xs text-gray-400">Event {e.id}{e.sealed ? ' · sealed' : ' · awaiting sealing'}</p>
              </div>
            )}
          </article>
        ))}
        {loading && <Spinner />}
        {next && !loading && (
          <button className="btn-secondary" onClick={() => void load(next)}>Show older</button>
        )}
      </div>
    </div>
  );
}
