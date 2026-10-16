import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { EmptyState, ErrorState, Spinner, StatusBadge } from '../../components/ui';
import { BookingWindowFields, windowToIso, type BookingWindow } from '../../components/BookingWindowFields';
import { HistoryPanel } from '../../components/HistoryPanel';
import { formatLondon, fromLondon, londonToday, toLondon } from '@shared/londonTime';
import { FAULT_SEVERITIES, FAULT_STATUSES, MAINTENANCE_STATUSES } from '@shared/validation';

interface Resource { id: string; name: string }
interface MaintenanceType { id: string; label: string; sort_order: number; is_active: boolean }
interface Admin { id: string; full_name: string }

interface MaintenanceRow {
  id: string;
  reference: string;
  resource_id: string;
  resource_name: string;
  maintenance_type_id: string;
  maintenance_type_label: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  status: string;
  blocks_availability: boolean;
  assigned_admin_id: string | null;
  assigned_admin_name: string | null;
  notes: string;
  conflict_exception_reason: string | null;
  bookings_needing_action: number;
}

interface BookingSummary {
  id: string;
  reference: string;
  status: string;
  starts_at: string;
  ends_at: string;
  resource_name: string;
  customer_name: string;
  organisation_name?: string | null;
}

interface AffectedRow extends Omit<BookingSummary, 'id'> {
  booking_id: string;
  action_status: 'needs_action' | 'resolved';
  resolution_note: string | null;
  notified_at: string | null;
}

interface MaintenanceDetail extends MaintenanceRow {
  is_blocking: boolean;
  affected_bookings: AffectedRow[];
  overlapping_bookings: BookingSummary[];
}

interface FaultRow {
  id: string;
  reference: string;
  resource_id: string;
  resource_name: string;
  description: string;
  severity: string;
  status: string;
  blocks_bookings: boolean;
  reported_at: string;
  reported_by_name: string | null;
  resolution_notes: string;
  resolved_at: string | null;
}

export const MAINTENANCE_STATUS_LABEL: Record<string, string> = { planned: 'Planned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const MAINTENANCE_STATUS_STYLE: Record<string, string> = {
  planned: 'bg-scout-blue/15 text-scout-blue',
  in_progress: 'bg-scout-orange/20 text-orange-800',
  completed: 'bg-scout-green/15 text-scout-green',
  cancelled: 'bg-gray-200 text-gray-600',
};
const FAULT_STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'Being fixed', resolved: 'Resolved', closed: 'Closed' };
const SEVERITY_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const SEVERITY_STYLE: Record<string, string> = {
  low: 'bg-gray-100 text-gray-700',
  medium: 'bg-scout-yellow/30 text-yellow-800',
  high: 'bg-scout-orange/20 text-orange-800',
  critical: 'bg-scout-red/15 text-scout-red',
};

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const badge = (label: string, style: string) => <span className={`badge ${style}`}>{label}</span>;

function isoToWindow(startsAt: string, endsAt: string): BookingWindow {
  const s = toLondon(startsAt);
  const e = toLondon(endsAt);
  return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

/** A native modal dialog: focus moves inside and stays there, Escape closes it. */
function Dialog({ title, id, onClose, children, wide }: { title: string; id: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} bg-transparent p-0 backdrop:bg-black/40`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="card w-full space-y-4">
        <div className="flex items-start justify-between gap-2">
          <h2 id={id} className="text-2xl">{title}</h2>
          <button type="button" className="text-sm font-bold text-scout-purple" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** Admin: planned and emergency maintenance, and faults (FR22). */
export default function AdminMaintenance() {
  const [tab, setTab] = useState<'maintenance' | 'faults' | 'types'>('maintenance');
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Maintenance</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Maintenance that blocks availability closes the resource, everything it is part of and everything that is part of it, just like a closure.
        Existing bookings are never cancelled automatically.
      </p>
      <div role="tablist" className="mt-4 flex flex-wrap gap-2">
        {([['maintenance', 'Maintenance'], ['faults', 'Faults'], ['types', 'Maintenance types']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'maintenance' && <MaintenanceList />}
      {tab === 'faults' && <FaultList />}
      {tab === 'types' && <Types />}
    </div>
  );
}

function MaintenanceList() {
  const { can } = useAuth();
  const { data: resources } = useApi<Resource[]>('/admin/resources');
  const { data: types } = useApi<MaintenanceType[]>('/admin/maintenance-types');
  const [rows, setRows] = useState<MaintenanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [status, setStatus] = useState('planned,in_progress');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editing, setEditing] = useState<MaintenanceRow | 'new' | null>(null);
  const [search] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(search.get('open'));

  async function load() {
    const params = new URLSearchParams();
    if (resourceId) params.set('resource_id', resourceId);
    if (typeId) params.set('type_id', typeId);
    if (status) params.set('status', status);
    try {
      if (from) params.set('from', fromLondon(from, '00:00'));
      if (to) params.set('to', fromLondon(to, '23:59'));
      setError(null);
      setRows(await api.get<MaintenanceRow[]>(`/admin/maintenance?${params}`));
    } catch (e) {
      setError(message(e, 'Could not load maintenance'));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, typeId, status, from, to]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="mf-resource">Resource</label>
          <select id="mf-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            <option value="">All</option>
            {resources?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mf-type">Type</label>
          <select id="mf-type" className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">All</option>
            {types?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mf-status">Status</label>
          <select id="mf-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="planned,in_progress">Planned or in progress</option>
            <option value="">All</option>
            {MAINTENANCE_STATUSES.map((s) => <option key={s} value={s}>{MAINTENANCE_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mf-from">From</label>
          <input id="mf-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="mf-to">To</label>
          <input id="mf-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {can('maintenance.manage') && <button className="btn-primary" onClick={() => setEditing('new')}>Schedule maintenance</button>}
      </div>

      <div className="mt-4 space-y-2">
        {error && <ErrorState message={error} />}
        {rows === null && !error && <Spinner />}
        {rows?.length === 0 && <EmptyState title="No maintenance matches these filters" />}
        {rows?.map((m) => (
          <button key={m.id} type="button" className="card block w-full text-left hover:ring-2 hover:ring-scout-purple/40" onClick={() => setOpenId(m.id)}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-black">{m.title}</p>
              <div className="flex flex-wrap gap-1">
                {badge(MAINTENANCE_STATUS_LABEL[m.status] ?? m.status, MAINTENANCE_STATUS_STYLE[m.status] ?? '')}
                {m.blocks_availability && m.status !== 'completed' && m.status !== 'cancelled' && badge('Blocks bookings', 'bg-scout-red/15 text-scout-red')}
                {m.bookings_needing_action > 0 && badge(`${m.bookings_needing_action} booking${m.bookings_needing_action === 1 ? '' : 's'} to follow up`, 'bg-scout-yellow/30 text-yellow-800')}
              </div>
            </div>
            <p className="text-sm text-gray-600">{m.resource_name} · {m.maintenance_type_label} · {m.reference}</p>
            <p className="text-sm text-gray-600">{formatLondon(m.starts_at)} to {formatLondon(m.ends_at)}{m.assigned_admin_name ? ` · ${m.assigned_admin_name}` : ''}</p>
          </button>
        ))}
      </div>

      {editing && (
        <MaintenanceEditor
          record={editing === 'new' ? null : editing}
          resources={resources ?? []}
          types={types ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            setOpenId(id);
            void load();
          }}
        />
      )}
      {openId && !editing && (
        <MaintenanceView
          id={openId}
          onClose={() => setOpenId(null)}
          onEdit={(m) => setEditing(m)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

function MaintenanceEditor({
  record, resources, types, onClose, onSaved,
}: { record: MaintenanceRow | null; resources: Resource[]; types: MaintenanceType[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { data: admins } = useApi<Admin[]>('/admin/maintenance/assignees');
  const [form, setForm] = useState(() => ({
    resource_id: record?.resource_id ?? resources[0]?.id ?? '',
    maintenance_type_id: record?.maintenance_type_id ?? types.find((t) => t.is_active)?.id ?? '',
    title: record?.title ?? '',
    description: record?.description ?? '',
    status: record?.status ?? 'planned',
    blocks_availability: record?.blocks_availability ?? true,
    assigned_admin_id: record?.assigned_admin_id ?? '',
    notes: record?.notes ?? '',
  }));
  const [win, setWin] = useState<BookingWindow>(() => {
    if (record) return isoToWindow(record.starts_at, record.ends_at);
    const today = londonToday();
    return { startDate: today, startTime: '09:00', endDate: today, endTime: '17:00' };
  });
  const [conflicts, setConflicts] = useState<BookingSummary[] | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent, acknowledge = false) {
    e.preventDefault();
    const iso = windowToIso(win);
    if (!iso) {
      setError('The end must be after the start');
      return;
    }
    if (acknowledge && !reason.trim()) {
      setError('Give a reason for scheduling maintenance over these bookings');
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      ...form,
      assigned_admin_id: form.assigned_admin_id || null,
      starts_at: iso.startsAt,
      ends_at: iso.endsAt,
      ...(acknowledge ? { acknowledge_conflicts: true, exception_reason: reason.trim() } : {}),
    };
    try {
      const saved = record
        ? await api.put<{ id: string }>(`/admin/maintenance/${record.id}`, payload)
        : await api.post<{ id: string }>('/admin/maintenance', payload);
      onSaved(saved.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflicts') {
        setConflicts((err.details as { conflicts: BookingSummary[] }).conflicts);
      } else if (err instanceof ApiError && err.code === 'conflicts_changed') {
        setConflicts(null);
        setError(err.message);
      } else {
        setError(message(err, 'Could not save maintenance'));
      }
    } finally {
      setSaving(false);
    }
  }

  const activeTypes = types.filter((t) => t.is_active || t.id === record?.maintenance_type_id);

  return (
    <Dialog id="mnt-editor-heading" title={record ? `Edit ${record.reference}` : 'Schedule maintenance'} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(e) => save(e)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="mnt-resource">Resource</label>
            <select id="mnt-resource" className="input" value={form.resource_id} onChange={(e) => { set('resource_id', e.target.value); setConflicts(null); }}>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="mnt-type">Type</label>
            <select id="mnt-type" className="input" value={form.maintenance_type_id} onChange={(e) => set('maintenance_type_id', e.target.value)}>
              {activeTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="mnt-title">Title</label>
          <input id="mnt-title" className="input" required minLength={2} maxLength={160} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="mnt-description">Description</label>
          <textarea id="mnt-description" className="input" rows={3} maxLength={4000} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <BookingWindowFields value={win} onChange={(w) => { setWin(w); setConflicts(null); }} idPrefix="mnt" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="mnt-status">Status</label>
            <select id="mnt-status" className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
              {MAINTENANCE_STATUSES.map((s) => <option key={s} value={s}>{MAINTENANCE_STATUS_LABEL[s]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="mnt-assignee">Assigned to</label>
            <select id="mnt-assignee" className="input" value={form.assigned_admin_id} onChange={(e) => set('assigned_admin_id', e.target.value)}>
              <option value="">Nobody yet</option>
              {admins?.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.blocks_availability} onChange={(e) => { set('blocks_availability', e.target.checked); setConflicts(null); }} />
          <span><strong>Block bookings during this period.</strong> The resource, anything it is part of and anything part of it cannot be booked.</span>
        </label>
        <div>
          <label className="label" htmlFor="mnt-notes">Internal notes</label>
          <textarea id="mnt-notes" className="input" rows={2} maxLength={4000} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        {conflicts && (
          <div className="rounded-lg border-2 border-scout-red/40 bg-scout-red/5 p-4" role="alert">
            <p className="font-black">This maintenance overlaps {conflicts.length} existing booking{conflicts.length === 1 ? '' : 's'}</p>
            <p className="mt-1 text-sm">They will not be cancelled. If you save anyway they are listed on the maintenance record so you can contact the customers and resolve each one.</p>
            <ul className="mt-2 space-y-1 text-sm">
              {conflicts.map((b) => (
                <li key={b.id}>
                  <Link to={`/bookings/${b.id}`} className="font-bold text-scout-purple">{b.reference}</Link> · {b.resource_name} · {formatLondon(b.starts_at)} to {formatLondon(b.ends_at)} · {b.customer_name}{b.organisation_name ? ` (${b.organisation_name})` : ''}
                </li>
              ))}
            </ul>
            <label className="label mt-3" htmlFor="mnt-reason">Reason for scheduling over these bookings</label>
            <input id="mnt-reason" className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn-primary mt-3" disabled={saving} onClick={(e) => save(e, true)}>Save anyway</button>
          </div>
        )}
        {error && <ErrorState message={error} />}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function MaintenanceView({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (m: MaintenanceRow) => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [m, setM] = useState<MaintenanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setM(await api.get<MaintenanceDetail>(`/admin/maintenance/${id}`));
    } catch (e) {
      setError(message(e, 'Could not load maintenance'));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function resolve(bookingId: string, status: 'resolved' | 'needs_action') {
    const note = status === 'resolved' ? prompt('How was this booking resolved? (optional)') : null;
    if (status === 'resolved' && note === null) return;
    try {
      await api.put(`/admin/maintenance/${id}/affected/${bookingId}`, { status, resolution_note: note || undefined });
      await load();
      onChanged();
    } catch (e) {
      setError(message(e, 'Could not update the booking'));
    }
  }

  async function notify() {
    if (!confirm('Email the customers of every affected booking about this maintenance?')) return;
    setBusy(true);
    setInfo(null);
    try {
      const res = await api.post<{ notified: number }>(`/admin/maintenance/${id}/notify`, { message: notice });
      setInfo(`Emailed ${res.notified} customer${res.notified === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(message(e, 'Could not send the emails'));
    } finally {
      setBusy(false);
    }
  }

  const manage = can('maintenance.manage');
  const recorded = new Set(m?.affected_bookings.map((b) => b.booking_id));
  const unrecorded = m?.overlapping_bookings.filter((b) => !recorded.has(b.id)) ?? [];

  return (
    <Dialog id="mnt-view-heading" title={m ? m.title : 'Maintenance'} onClose={onClose} wide>
      {error && <ErrorState message={error} />}
      {!m && !error && <Spinner />}
      {m && (
        <>
          <div className="flex flex-wrap gap-1">
            {badge(MAINTENANCE_STATUS_LABEL[m.status] ?? m.status, MAINTENANCE_STATUS_STYLE[m.status] ?? '')}
            {m.is_blocking ? badge('Blocks bookings', 'bg-scout-red/15 text-scout-red') : badge('Bookings allowed', 'bg-gray-100 text-gray-700')}
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto,1fr]">
            <dt className="font-bold">Reference</dt><dd>{m.reference}</dd>
            <dt className="font-bold">Resource</dt><dd>{m.resource_name}</dd>
            <dt className="font-bold">Type</dt><dd>{m.maintenance_type_label}</dd>
            <dt className="font-bold">When</dt><dd>{formatLondon(m.starts_at)} to {formatLondon(m.ends_at)}</dd>
            <dt className="font-bold">Assigned to</dt><dd>{m.assigned_admin_name ?? 'Nobody yet'}</dd>
            {m.description && <><dt className="font-bold">Description</dt><dd className="whitespace-pre-line">{m.description}</dd></>}
            {m.notes && <><dt className="font-bold">Notes</dt><dd className="whitespace-pre-line">{m.notes}</dd></>}
            {m.conflict_exception_reason && <><dt className="font-bold">Scheduled over bookings because</dt><dd>{m.conflict_exception_reason}</dd></>}
          </dl>
          {manage && <button type="button" className="btn-secondary" onClick={() => onEdit(m)}>Edit, start, complete or cancel</button>}

          <section aria-labelledby="mnt-affected-heading">
            <h3 id="mnt-affected-heading" className="text-xl">Affected bookings</h3>
            {m.affected_bookings.length === 0 && unrecorded.length === 0 && <p className="text-sm text-gray-600">No bookings overlap this maintenance.</p>}
            <ul className="mt-2 space-y-2">
              {m.affected_bookings.map((b) => (
                <li key={b.booking_id} className="rounded-lg border border-gray-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <Link to={`/bookings/${b.booking_id}`} className="font-bold text-scout-purple">{b.reference}</Link> · {b.resource_name} · {b.customer_name}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge status={b.status} />
                      {b.action_status === 'resolved' ? badge('Resolved', 'bg-scout-green/15 text-scout-green') : badge('Needs action', 'bg-scout-yellow/30 text-yellow-800')}
                    </span>
                  </div>
                  <p className="text-gray-600">{formatLondon(b.starts_at)} to {formatLondon(b.ends_at)}{b.notified_at ? ` · Customer emailed ${formatLondon(b.notified_at)}` : ''}</p>
                  {b.resolution_note && <p className="text-gray-600">Resolution: {b.resolution_note}</p>}
                  {manage && (
                    <button type="button" className="mt-1 text-sm font-bold text-scout-purple" onClick={() => resolve(b.booking_id, b.action_status === 'resolved' ? 'needs_action' : 'resolved')}>
                      {b.action_status === 'resolved' ? 'Mark as needing action' : 'Mark as resolved'}
                    </button>
                  )}
                </li>
              ))}
              {unrecorded.map((b) => (
                <li key={b.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                  <Link to={`/bookings/${b.id}`} className="font-bold text-scout-purple">{b.reference}</Link> · {b.resource_name} · {b.customer_name}
                  <p className="text-gray-600">{formatLondon(b.starts_at)} to {formatLondon(b.ends_at)} · Overlaps, but bookings are still allowed during this maintenance</p>
                </li>
              ))}
            </ul>
            {manage && m.status !== 'cancelled' && (m.affected_bookings.length > 0 || unrecorded.length > 0) && (
              <div className="mt-3 space-y-2">
                <label className="label" htmlFor="mnt-notice">Message to customers (added to the maintenance notice email)</label>
                <textarea id="mnt-notice" className="input" rows={2} maxLength={2000} value={notice} onChange={(e) => setNotice(e.target.value)} />
                <button type="button" className="btn-primary" disabled={busy} onClick={notify}>{busy ? 'Sending…' : 'Email affected customers'}</button>
                {info && <p className="text-sm text-scout-green" role="status">{info}</p>}
              </div>
            )}
          </section>
          <HistoryPanel filters={{ entity_id: m.id }} />
        </>
      )}
    </Dialog>
  );
}

function FaultList() {
  const { can } = useAuth();
  const { data: resources } = useApi<Resource[]>('/admin/resources');
  const [rows, setRows] = useState<FaultRow[] | null>(null);
  const [status, setStatus] = useState('open,in_progress');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FaultRow | 'new' | null>(null);

  async function load() {
    try {
      setError(null);
      setRows(await api.get<FaultRow[]>(`/admin/faults${status ? `?status=${status}` : ''}`));
    } catch (e) {
      setError(message(e, 'Could not load faults'));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="ff-status">Status</label>
          <select id="ff-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open,in_progress">Open or being fixed</option>
            <option value="">All</option>
            {FAULT_STATUSES.map((s) => <option key={s} value={s}>{FAULT_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        {can('maintenance.manage') && <button className="btn-primary" onClick={() => setEditing('new')}>Report a fault</button>}
      </div>
      <div className="mt-4 space-y-2">
        {error && <ErrorState message={error} />}
        {rows === null && !error && <Spinner />}
        {rows?.length === 0 && <EmptyState title="No faults" />}
        {rows?.map((f) => (
          <div key={f.id} className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-black">{f.resource_name}: {f.description}</p>
              <div className="flex flex-wrap gap-1">
                {badge(SEVERITY_LABEL[f.severity], SEVERITY_STYLE[f.severity])}
                {badge(FAULT_STATUS_LABEL[f.status] ?? f.status, 'bg-gray-100 text-gray-700')}
                {f.blocks_bookings && (f.status === 'open' || f.status === 'in_progress') && badge('Prevents bookings', 'bg-scout-red/15 text-scout-red')}
              </div>
            </div>
            <p className="text-sm text-gray-600">{f.reference} · Reported {formatLondon(f.reported_at)}{f.reported_by_name ? ` by ${f.reported_by_name}` : ''}{f.resolved_at ? ` · Resolved ${formatLondon(f.resolved_at)}` : ''}</p>
            {f.resolution_notes && <p className="text-sm text-gray-600">{f.resolution_notes}</p>}
            {can('maintenance.manage') && <button type="button" className="mt-1 text-sm font-bold text-scout-purple" onClick={() => setEditing(f)}>Update</button>}
          </div>
        ))}
      </div>
      {editing && (
        <FaultEditor
          fault={editing === 'new' ? null : editing}
          resources={resources ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

function FaultEditor({ fault, resources, onClose, onSaved }: { fault: FaultRow | null; resources: Resource[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(() => ({
    resource_id: fault?.resource_id ?? resources[0]?.id ?? '',
    description: fault?.description ?? '',
    severity: fault?.severity ?? 'medium',
    status: fault?.status ?? 'open',
    blocks_bookings: fault?.blocks_bookings ?? false,
    resolution_notes: fault?.resolution_notes ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [affected, setAffected] = useState<BookingSummary[] | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = fault
        ? await api.put<{ affected_bookings: BookingSummary[] }>(`/admin/faults/${fault.id}`, form)
        : await api.post<{ affected_bookings: BookingSummary[] }>('/admin/faults', form);
      onSaved();
      if (res.affected_bookings.length) setAffected(res.affected_bookings);
      else onClose();
    } catch (err) {
      setError(message(err, 'Could not save the fault'));
    } finally {
      setSaving(false);
    }
  }

  if (affected) {
    return (
      <Dialog id="fault-affected-heading" title="Bookings to follow up" onClose={onClose}>
        <p className="text-sm">The fault is saved and the resource can no longer be booked. These existing bookings are still in place and may need you to contact the customer:</p>
        <ul className="space-y-1 text-sm">
          {affected.map((b) => (
            <li key={b.id}><Link to={`/bookings/${b.id}`} className="font-bold text-scout-purple">{b.reference}</Link> · {b.resource_name} · {formatLondon(b.starts_at)} · {b.customer_name}</li>
          ))}
        </ul>
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </Dialog>
    );
  }

  return (
    <Dialog id="fault-editor-heading" title={fault ? `Update ${fault.reference}` : 'Report a fault'} onClose={onClose}>
      <form className="space-y-4" onSubmit={save}>
        <div>
          <label className="label" htmlFor="flt-resource">Resource</label>
          <select id="flt-resource" className="input" value={form.resource_id} onChange={(e) => set('resource_id', e.target.value)}>
            {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="flt-description">What is wrong?</label>
          <textarea id="flt-description" className="input" rows={3} required minLength={3} maxLength={4000} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="flt-severity">Severity</label>
            <select
              id="flt-severity"
              className="input"
              value={form.severity}
              onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value, blocks_bookings: e.target.value === 'critical' ? true : f.blocks_bookings }))}
            >
              {FAULT_SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="flt-status">Status</label>
            <select id="flt-status" className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
              {FAULT_STATUSES.map((s) => <option key={s} value={s}>{FAULT_STATUS_LABEL[s]}</option>)}
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.blocks_bookings} onChange={(e) => set('blocks_bookings', e.target.checked)} />
          <span><strong>Prevents bookings.</strong> The resource cannot be booked until the fault is resolved. Existing bookings are kept.</span>
        </label>
        <div>
          <label className="label" htmlFor="flt-resolution">Resolution notes</label>
          <textarea id="flt-resolution" className="input" rows={2} maxLength={4000} value={form.resolution_notes} onChange={(e) => set('resolution_notes', e.target.value)} />
        </div>
        {error && <ErrorState message={error} />}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function Types() {
  const { can } = useAuth();
  const [rows, setRows] = useState<MaintenanceType[] | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api.get<MaintenanceType[]>('/admin/maintenance-types'));
    } catch (e) {
      setError(message(e, 'Could not load maintenance types'));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/admin/maintenance-types', { label, sort_order: (rows?.length ?? 0) + 1 });
      setLabel('');
      await load();
    } catch (err) {
      setError(message(err, 'Could not add the type'));
    }
  }

  async function update(t: MaintenanceType, changes: Partial<MaintenanceType>) {
    setError(null);
    try {
      await api.put(`/admin/maintenance-types/${t.id}`, { label: t.label, sort_order: t.sort_order, is_active: t.is_active, ...changes });
      await load();
    } catch (err) {
      setError(message(err, 'Could not update the type'));
    }
  }

  const manage = can('maintenance.manage');
  return (
    <div className="mt-6 space-y-4">
      {manage && (
        <form className="card flex flex-wrap items-end gap-3" onSubmit={add}>
          <div className="grow">
            <label className="label" htmlFor="mt-label">New maintenance type</label>
            <input id="mt-label" className="input" required minLength={2} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <button className="btn-primary">Add</button>
        </form>
      )}
      {error && <ErrorState message={error} />}
      {rows === null && !error && <Spinner />}
      <ul className="space-y-2">
        {rows?.map((t) => (
          <li key={t.id} className="card flex flex-wrap items-center justify-between gap-2">
            <span className={t.is_active ? 'font-bold' : 'text-gray-500 line-through'}>{t.label}</span>
            {manage && (
              <span className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => { const v = prompt('Rename maintenance type', t.label); if (v?.trim()) void update(t, { label: v.trim() }); }}>Rename</button>
                <button type="button" className="btn-secondary" onClick={() => update(t, { is_active: !t.is_active })}>{t.is_active ? 'Retire' : 'Restore'}</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-gray-600">Retired types stay on existing records but cannot be chosen for new maintenance.</p>
    </div>
  );
}
