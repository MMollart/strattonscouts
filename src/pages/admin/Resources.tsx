import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { BookingWindowFields, type BookingWindow, windowToIso } from '../../components/BookingWindowFields';
import { formatLondon, londonToday } from '@shared/londonTime';

interface ResourceRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  resource_type: 'individual' | 'combined';
  is_active: boolean;
  requires_approval: boolean;
  pricing_model: 'hourly' | 'nightly' | 'fixed';
}

type Draft = Omit<ResourceRow, 'id'> & { id?: string };

const EMPTY: Draft = {
  name: '', slug: '', description: '', resource_type: 'individual',
  is_active: true, requires_approval: false, pricing_model: 'hourly',
};

export default function AdminResources() {
  const { data, loading, error } = useApi<ResourceRow[]>('/admin/resources');
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);

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

      <button className="btn-primary mt-4" onClick={() => setEditing({ ...EMPTY })}>Add resource</button>

      <div className="mt-6 space-y-2">
        {rows.length === 0 && <EmptyState title="No resources yet" />}
        {rows.map((r) => (
          <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-black">{r.name} {!r.is_active && <span className="badge bg-gray-200 text-gray-600">inactive</span>}</p>
              <p className="text-xs text-gray-500">
                /{r.slug} · {r.resource_type} · {r.pricing_model}{r.requires_approval ? ' · requires approval' : ''}
              </p>
            </div>
            <button className="btn-secondary" onClick={() => setEditing(r)}>Edit</button>
          </div>
        ))}
      </div>

      <ClosuresPanel resources={rows} />

      {editing && (
        <ResourceEditor
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

function ResourceEditor({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
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
      resource_type: form.resource_type, is_active: form.is_active,
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
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.upload(`/admin/resources/${form.id}/image`, fd);
      setUploadMsg('Image uploaded.');
    } catch (err) {
      setUploadMsg(err instanceof ApiError ? err.message : 'Upload failed');
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
            <label className="label" htmlFor="r-type">Type</label>
            <select id="r-type" className="input" value={form.resource_type} onChange={(e) => setForm({ ...form, resource_type: e.target.value as Draft['resource_type'] })}>
              <option value="individual">Individual</option>
              <option value="combined">Combined</option>
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
            <input id="r-image" ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="text-sm" />
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

  const nameOf = (id: string) => resources.find((r) => r.id === id)?.name ?? 'Unknown resource';
  const upcoming = closures?.filter((c) => c.ends_at > new Date().toISOString()) ?? [];

  return (
    <section className="mt-10" aria-labelledby="closures-heading">
      <h2 id="closures-heading" className="text-2xl">Closed periods</h2>
      <p className="mt-1 text-sm text-gray-600">
        Block out times when a resource cannot be booked. Closing the Whole Venue closes everything; closing a single
        space also makes the Whole Venue unavailable. Existing bookings are not changed.
      </p>

      <form className="card mt-4 space-y-4" onSubmit={add}>
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
      </form>

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
            <button type="button" className="btn-secondary" onClick={() => remove(c.id)}>Remove</button>
          </div>
        ))}
      </div>
    </section>
  );
}
