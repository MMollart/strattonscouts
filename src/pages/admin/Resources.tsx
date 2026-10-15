import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { needsShrinking, shrinkImage, ShrinkError } from '../../lib/shrinkImage';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { BookingWindowFields, type BookingWindow, windowToIso } from '../../components/BookingWindowFields';
import { formatLondon, londonToday } from '@shared/londonTime';
import { describeRule, parseDays } from '@shared/availability-rules';
import { ancestorIds, isWithin, parentOptions, wouldCreateLoop } from '@shared/hierarchy';

interface ResourceRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  parent_id: string | null;
  is_active: boolean;
  requires_approval: boolean;
  pricing_model: 'hourly' | 'nightly' | 'fixed';
  min_notice_minutes?: number | null;
  max_advance_days?: number | null;
  provisional_expiry_hours?: number | null;
}

type Draft = Omit<ResourceRow, 'id'> & { id?: string };

const EMPTY: Draft = {
  name: '', slug: '', description: '', parent_id: null,
  is_active: true, requires_approval: false, pricing_model: 'hourly',
};

export default function AdminResources() {
  const { can } = useAuth();
  const { data, loading, error } = useApi<ResourceRow[]>('/admin/resources');
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [limits, setLimits] = useState<ResourceRow | null>(null);
  const [within, setWithin] = useState('');
  const groups = parentOptions(rows);

  useEffect(() => { if (data) setRows(data); }, [data]);

  async function reload() {
    setRows(await api.get<ResourceRow[]>('/admin/resources'));
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Resources</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>

      {can('resources.manage') && <button className="btn-primary mt-4" onClick={() => setEditing({ ...EMPTY })}>Add resource</button>}

      {groups.length > 0 && (
        <div className="mt-6 max-w-xs">
          <label className="label" htmlFor="admin-within">Show</label>
          <select id="admin-within" className="input" value={within} onChange={(e) => setWithin(e.target.value)}>
            <option value="">All resources</option>
            {groups.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {'\u00a0\u00a0'.repeat(depth)}{node.name} and everything in it
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {rows.length === 0 && <EmptyState title="No resources yet" />}
        {treeOrder(rows)
          .filter(({ row }) => !within || isWithin(row.id, within, (id) => ancestorIds(id, rows)))
          .map(({ row: r, depth }) => (
          <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2" style={{ marginLeft: `${Math.min(depth, 4) * 1.5}rem` }}>
            <div>
              <p className="font-black">{r.name} {!r.is_active && <span className="badge bg-gray-200 text-gray-600">inactive</span>}</p>
              <p className="text-xs text-gray-500">
                /{r.slug}{r.parent_id ? ` · part of ${rows.find((p) => p.id === r.parent_id)?.name ?? 'another resource'}` : ''} · {r.pricing_model}{r.requires_approval ? ' · requires approval' : ''}
                {r.min_notice_minutes ? ` · ${r.min_notice_minutes / 60}h notice` : ''}
                {r.max_advance_days ? ` · up to ${r.max_advance_days} days ahead` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              {can('availability.manage') && <button className="btn-secondary" onClick={() => setLimits(r)}>Booking limits</button>}
              {can('resources.manage') && <button className="btn-secondary" onClick={() => setEditing(r)}>Edit</button>}
            </div>
          </div>
        ))}
      </div>

      <RulesPanel resources={rows} />

      <ClosuresPanel resources={rows} />

      {limits && (
        <LimitsEditor
          resource={limits}
          onClose={() => setLimits(null)}
          onSaved={async () => { setLimits(null); await reload(); }}
        />
      )}

      {editing && (
        <ResourceEditor
          draft={editing}
          resources={rows}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

/** Resources with each child listed under its parent, and how deep it sits. */
function treeOrder(rows: ResourceRow[]): { row: ResourceRow; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const out: { row: ResourceRow; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const row of rows) {
      const parent = row.parent_id && ids.has(row.parent_id) ? row.parent_id : null;
      if (parent !== parentId || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ row, depth });
      visit(row.id, depth + 1);
    }
  };
  visit(null, 0);
  // Anything left over sits in a loop; show it rather than hide it.
  for (const row of rows) if (!seen.has(row.id)) out.push({ row, depth: 0 });
  return out;
}

function ResourceEditor({ draft, resources, onClose, onSaved }: { draft: Draft; resources: ResourceRow[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // A native modal dialog moves focus inside, keeps it there, closes on
  // Escape and returns focus to the trigger when closed.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload = {
      name: form.name, slug: form.slug, description: form.description,
      parent_id: form.parent_id, is_active: form.is_active,
      requires_approval: form.requires_approval, pricing_model: form.pricing_model,
    };
    try {
      if (form.id) await api.put(`/admin/resources/${form.id}`, payload);
      else await api.post('/admin/resources', payload);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save resource');
    } finally {
      setSaving(false);
    }
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file || !form.id) return;
    setUploadMsg(null);
    try {
      let toSend = file;
      if (needsShrinking(file)) {
        setUploadMsg('Shrinking image…');
        toSend = await shrinkImage(file);
      }
      const fd = new FormData();
      fd.append('file', toSend);
      await api.upload(`/admin/resources/${form.id}/image`, fd);
      setUploadMsg(
        toSend === file
          ? 'Image uploaded.'
          : `Image uploaded, shrunk from ${(file.size / 1048576).toFixed(1)} MB to ${(toSend.size / 1048576).toFixed(1)} MB.`,
      );
    } catch (err) {
      setUploadMsg(err instanceof ApiError || err instanceof ShrinkError ? err.message : 'Upload failed');
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="resource-editor-heading"
      className="w-full max-w-lg bg-transparent p-0 backdrop:bg-black/40"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form className="card w-full space-y-4" onSubmit={save}>
        <h2 id="resource-editor-heading" className="text-2xl">{form.id ? 'Edit resource' : 'New resource'}</h2>
        <div>
          <label className="label" htmlFor="r-name">Name</label>
          <input id="r-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div>
          <label className="label" htmlFor="r-slug">Slug</label>
          <input id="r-slug" className="input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required pattern="[a-z0-9-]+" />
        </div>
        <div>
          <label className="label" htmlFor="r-desc">Description</label>
          <textarea id="r-desc" className="input" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="r-parent">Part of</label>
            <select id="r-parent" className="input" aria-describedby="r-parent-help" value={form.parent_id ?? ''} onChange={(e) => setForm({ ...form, parent_id: e.target.value || null })}>
              <option value="">Nothing (top level)</option>
              {resources
                .filter((r) => !form.id || !wouldCreateLoop(form.id, r.id, resources))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {[...ancestorIds(r.id, resources)].reverse().map((a) => `${resources.find((x) => x.id === a)?.name} › `).join('')}
                    {r.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="r-model">Pricing model</label>
            <select id="r-model" className="input" value={form.pricing_model} onChange={(e) => setForm({ ...form, pricing_model: e.target.value as Draft['pricing_model'] })}>
              <option value="hourly">Hourly</option>
              <option value="nightly">Nightly</option>
              <option value="fixed">Fixed</option>
            </select>
          </div>
        </div>
        <p id="r-parent-help" className="text-sm text-gray-600">
          Booking a resource also makes everything it is part of, and everything that is part of it, unavailable at
          the same time. Resources side by side (for example two halls) can still be booked separately.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
          <span className="font-bold">Active (bookable by customers)</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.requires_approval} onChange={(e) => setForm({ ...form, requires_approval: e.target.checked })} />
          <span className="font-bold">Requires administrator approval</span>
        </label>

        {form.id && (
          <div className="rounded-xl bg-scout-off-white p-3">
            <label className="label" htmlFor="r-image">Primary image</label>
            <input id="r-image" ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="text-sm" />
            <p className="mt-1 text-xs text-gray-500">JPEG, PNG, WebP or iPhone (HEIC) photos. Images over 5 MB are shrunk automatically before upload.</p>
            <button type="button" className="btn-secondary mt-2" onClick={upload}>Upload image</button>
            {uploadMsg && <p className="mt-2 text-sm">{uploadMsg}</p>}
          </div>
        )}

        {error && <ErrorState message={error} />}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

interface ClosureRow {
  id: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
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
    <section className="mt-10" aria-labelledby="closures-heading">
      <h2 id="closures-heading" className="text-2xl">Closed periods</h2>
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
            {canManage && <button type="button" className="btn-secondary" onClick={() => remove(c.id)}>Remove</button>}
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
    <section className="mt-10" aria-labelledby="rules-heading">
      <h2 id="rules-heading" className="text-2xl">Recurring availability rules</h2>
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
