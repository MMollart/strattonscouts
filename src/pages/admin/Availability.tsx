import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { BookingWindowFields, type BookingWindow, windowToIso } from '../../components/BookingWindowFields';
import { formatLondon, londonToday } from '@shared/londonTime';
import { describeRule, parseDays } from '@shared/availability-rules';
import { treeOrder, type ResourceRow } from './Resources';

/** Loads the resource list that every availability page chooses from. */
function WithResources({ children }: { children: (resources: ResourceRow[], reload: () => Promise<void>) => React.ReactNode }) {
  const { data, loading, error, setData } = useApi<ResourceRow[]>('/admin/resources');
  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;
  return <>{children(data, async () => setData(await api.get<ResourceRow[]>('/admin/resources')))}</>;
}

/** Admin: recurring opening hours and regular unavailable times. */
export function AdminAvailabilityRules() {
  return <WithResources>{(resources) => <RulesPanel resources={resources} />}</WithResources>;
}

/** Admin: one-off closed periods. */
export function AdminClosures() {
  return <WithResources>{(resources) => <ClosuresPanel resources={resources} />}</WithResources>;
}

/** Admin: per-resource notice, advance-booking and provisional-hold limits. */
export function AdminBookingLimits() {
  return <WithResources>{(resources, reload) => <LimitsPanel resources={resources} reload={reload} />}</WithResources>;
}

function LimitsPanel({ resources, reload }: { resources: ResourceRow[]; reload: () => Promise<void> }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState<ResourceRow | null>(null);
  return (
    <section aria-labelledby="limits-page-heading">
      <h1 id="limits-page-heading" className="text-3xl">Booking limits</h1>
      <p className="mt-1 text-sm text-gray-600">
        How much notice each resource needs, how far ahead it can be booked and how long provisional holds last.
        Limits apply to new bookings only.
      </p>
      <div className="mt-4 space-y-2">
        {resources.length === 0 && <EmptyState title="No resources yet" />}
        {treeOrder(resources).map(({ row: r, depth }) => (
          <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2" style={{ marginLeft: `${Math.min(depth, 4) * 1.5}rem` }}>
            <div>
              <p className="font-black">{r.name} {!r.is_active && <span className="badge bg-gray-200 text-gray-600">inactive</span>}</p>
              <p className="text-sm text-gray-600">
                {r.min_notice_minutes ? `${r.min_notice_minutes / 60}h notice` : 'No minimum notice'}
                {' · '}{r.max_advance_days ? `up to ${r.max_advance_days} days ahead` : 'no advance limit'}
                {' · '}{r.provisional_expiry_hours ? `${r.provisional_expiry_hours}h provisional hold` : 'default provisional hold'}
              </p>
            </div>
            {can('availability.manage') && <button type="button" className="btn-secondary" onClick={() => setEditing(r)}>Edit limits</button>}
          </div>
        ))}
      </div>
      {editing && (
        <LimitsEditor
          resource={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
        />
      )}
    </section>
  );
}


interface ClosureRow {
  id: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  maintenance_id: string | null;
  fault_id: string | null;
}

function ClosuresPanel({ resources }: { resources: ResourceRow[] }) {
  const { can } = useAuth();
  const [closures, setClosures] = useState<ClosureRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [win, setWin] = useState<BookingWindow>(() => {
    const today = londonToday();
    return { startDate: today, startTime: '00:00', endDate: today, endTime: '23:59' };
  });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setClosures(await api.get<ClosureRow[]>('/admin/closures'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load closures');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!resourceId && resources.length) setResourceId(resources[0].id);
  }, [resources, resourceId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const iso = windowToIso(win);
    if (!iso) {
      setError('The end must be after the start');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post('/admin/closures', {
        resource_id: resourceId,
        starts_at: iso.startsAt,
        ends_at: iso.endsAt,
        reason: reason.trim() || undefined,
      });
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add closure');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this closure? The period will become bookable again.')) return;
    try {
      await api.del('/admin/closures', { id });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove closure');
    }
  }

  const canManage = can('availability.manage');
  const nameOf = (id: string) => resources.find((r) => r.id === id)?.name ?? 'Unknown resource';
  const upcoming = closures?.filter((c) => c.ends_at > new Date().toISOString()) ?? [];

  return (
    <section aria-labelledby="closures-heading">
      <h1 id="closures-heading" className="text-3xl">Closed periods</h1>
      <p className="mt-1 text-sm text-gray-600">
        Block out times when a resource cannot be booked. Closing the Whole Venue closes everything; closing a single
        space also makes the Whole Venue unavailable. Existing bookings are not changed.
      </p>

      {canManage && <form className="card mt-4 space-y-4" onSubmit={add}>
        <div>
          <label className="label" htmlFor="cl-resource">Resource</label>
          <select id="cl-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <BookingWindowFields value={win} onChange={setWin} idPrefix="cl" />
        <div>
          <label className="label" htmlFor="cl-reason">Reason (optional, not shown to customers)</label>
          <input id="cl-reason" className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <ErrorState message={error} />}
        <button className="btn-primary" disabled={saving || !resourceId}>{saving ? 'Adding…' : 'Add closure'}</button>
      </form>}

      <div className="mt-4 space-y-2">
        {closures === null && !error && <Spinner />}
        {closures && upcoming.length === 0 && <EmptyState title="No upcoming closures" />}
        {upcoming.map((c) => (
          <div key={c.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-black">{nameOf(c.resource_id)}</p>
              <p className="text-sm text-gray-600">{formatLondon(c.starts_at)} to {formatLondon(c.ends_at)}</p>
              {c.reason && <p className="text-xs text-gray-500">{c.reason}</p>}
            </div>
            {c.maintenance_id || c.fault_id ? (
              <Link to="/admin/maintenance" className="text-sm font-bold text-scout-purple">
                {c.maintenance_id ? 'Managed by maintenance' : 'Managed by a fault report'}
              </Link>
            ) : (
              canManage && <button type="button" className="btn-secondary" onClick={() => remove(c.id)}>Remove</button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LimitsEditor({ resource, onClose, onSaved }: { resource: ResourceRow; onClose: () => void; onSaved: () => void }) {
  const [noticeHours, setNoticeHours] = useState(resource.min_notice_minutes ? String(resource.min_notice_minutes / 60) : '');
  const [advanceDays, setAdvanceDays] = useState(resource.max_advance_days ? String(resource.max_advance_days) : '');
  const [holdHours, setHoldHours] = useState(resource.provisional_expiry_hours ? String(resource.provisional_expiry_hours) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.put(`/admin/resources/${resource.id}/restrictions`, {
        min_notice_minutes: noticeHours ? Math.round(Number(noticeHours) * 60) : null,
        max_advance_days: advanceDays ? Number(advanceDays) : null,
        provisional_expiry_hours: holdHours ? Number(holdHours) : null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save limits');
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="limits-heading"
      className="w-full max-w-md bg-transparent p-0 backdrop:bg-black/40"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <form className="card w-full space-y-4" onSubmit={save}>
        <h2 id="limits-heading" className="text-2xl">Booking limits: {resource.name}</h2>
        <div>
          <label className="label" htmlFor="lim-notice">Minimum notice (hours)</label>
          <input id="lim-notice" className="input" type="number" min={0} step={0.5} value={noticeHours} onChange={(e) => setNoticeHours(e.target.value)} placeholder="No minimum" />
        </div>
        <div>
          <label className="label" htmlFor="lim-advance">Bookable up to (days ahead)</label>
          <input id="lim-advance" className="input" type="number" min={1} max={3650} value={advanceDays} onChange={(e) => setAdvanceDays(e.target.value)} placeholder="No limit" />
        </div>
        <div>
          <label className="label" htmlFor="lim-hold">Provisional hold (hours)</label>
          <input id="lim-hold" className="input" type="number" min={1} max={720} value={holdHours} onChange={(e) => setHoldHours(e.target.value)} placeholder="Use the global setting" />
        </div>
        <p className="text-xs text-gray-500">Limits apply to new bookings only. Existing bookings are not changed.</p>
        {error && <ErrorState message={error} />}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

interface RuleRow {
  id: string;
  resource_id: string;
  resource_name: string;
  rule_type: 'closed' | 'open';
  days_of_week: string;
  start_time: string;
  end_time: string;
  valid_from: string | null;
  valid_to: string | null;
  label: string | null;
  is_active: boolean;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface RuleDraft {
  id?: string;
  resource_id: string;
  rule_type: 'closed' | 'open';
  days: number[];
  start_time: string;
  end_time: string;
  valid_from: string;
  valid_to: string;
  label: string;
  is_active: boolean;
}

function RulesPanel({ resources }: { resources: ResourceRow[] }) {
  const { can } = useAuth();
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const canManage = can('availability.manage');

  async function load() {
    try {
      setRules(await api.get<RuleRow[]>('/admin/availability-rules'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load rules');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function blank(): RuleDraft {
    return {
      resource_id: resources[0]?.id ?? '', rule_type: 'closed', days: [0, 1, 2, 3, 4], start_time: '18:00', end_time: '21:00',
      valid_from: '', valid_to: '', label: '', is_active: true,
    };
  }

  function edit(r: RuleRow): RuleDraft {
    return {
      id: r.id, resource_id: r.resource_id, rule_type: r.rule_type, days: parseDays(r.days_of_week), start_time: r.start_time,
      end_time: r.end_time, valid_from: r.valid_from ?? '', valid_to: r.valid_to ?? '', label: r.label ?? '', is_active: r.is_active,
    };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    const payload = {
      resource_id: draft.resource_id, rule_type: draft.rule_type, days_of_week: draft.days, start_time: draft.start_time,
      end_time: draft.end_time, valid_from: draft.valid_from || null, valid_to: draft.valid_to || null,
      label: draft.label.trim() || null, is_active: draft.is_active,
    };
    try {
      if (draft.id) await api.put(`/admin/availability-rules/${draft.id}`, payload);
      else await api.post('/admin/availability-rules', payload);
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save rule');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this rule? Existing bookings are not changed.')) return;
    try {
      await api.del(`/admin/availability-rules/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete rule');
    }
  }

  const toggleDay = (d: number) =>
    draft && setDraft({ ...draft, days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() });

  return (
    <section aria-labelledby="rules-heading">
      <h1 id="rules-heading" className="text-3xl">Opening hours &amp; rules</h1>
      <p className="mt-1 text-sm text-gray-600">
        &quot;Unavailable&quot; rules block a regular time, such as weekday evenings for Scout meetings. &quot;Open&quot; rules set opening hours:
        once a resource has any, bookings must fall inside them. An end time at or before the start runs past midnight. Unavailable
        rules on the Whole Venue apply to every space, and on a space they also block the Whole Venue.
      </p>
      {canManage && !draft && <button className="btn-primary mt-4" onClick={() => setDraft(blank())}>Add rule</button>}

      {draft && (
        <form className="card mt-4 space-y-4" onSubmit={save} aria-label={draft.id ? 'Edit rule' : 'New rule'}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="ar-resource">Resource</label>
              <select id="ar-resource" className="input" value={draft.resource_id} onChange={(e) => setDraft({ ...draft, resource_id: e.target.value })}>
                {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ar-type">Rule</label>
              <select id="ar-type" className="input" value={draft.rule_type} onChange={(e) => setDraft({ ...draft, rule_type: e.target.value as RuleDraft['rule_type'] })}>
                <option value="closed">Unavailable at these times</option>
                <option value="open">Open only at these times</option>
              </select>
            </div>
          </div>
          <fieldset>
            <legend className="label">Days</legend>
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={draft.days.includes(i)} onChange={() => toggleDay(i)} /> {d}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="ar-start">From (UK time)</label>
              <input id="ar-start" type="time" className="input" value={draft.start_time} onChange={(e) => setDraft({ ...draft, start_time: e.target.value })} required />
            </div>
            <div>
              <label className="label" htmlFor="ar-end">Until</label>
              <input id="ar-end" type="time" className="input" value={draft.end_time} onChange={(e) => setDraft({ ...draft, end_time: e.target.value })} required />
            </div>
            <div>
              <label className="label" htmlFor="ar-vf">Season starts (optional)</label>
              <input id="ar-vf" type="date" className="input" value={draft.valid_from} onChange={(e) => setDraft({ ...draft, valid_from: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="ar-vt">Season ends (optional)</label>
              <input id="ar-vt" type="date" className="input" value={draft.valid_to} onChange={(e) => setDraft({ ...draft, valid_to: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="ar-label">Label (shown to customers)</label>
            <input id="ar-label" className="input" maxLength={120} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Scout meetings" />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
            <span className="font-bold">Active</span>
          </label>
          {error && <ErrorState message={error} />}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving || draft.days.length === 0}>{saving ? 'Saving…' : 'Save rule'}</button>
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="mt-4 space-y-2">
        {rules === null && !error && <Spinner />}
        {!draft && error && <ErrorState message={error} />}
        {rules && rules.length === 0 && <EmptyState title="No recurring rules" />}
        {rules?.map((r) => (
          <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-black">{r.resource_name} {!r.is_active && <span className="badge bg-gray-200 text-gray-600">inactive</span>}</p>
              <p className="text-sm text-gray-600">{describeRule(r)}</p>
            </div>
            {canManage && (
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => setDraft(edit(r))}>Edit</button>
                <button type="button" className="btn-secondary" onClick={() => remove(r.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
