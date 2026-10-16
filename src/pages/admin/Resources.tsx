import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { needsShrinking, shrinkImage, ShrinkError } from '../../lib/shrinkImage';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { ancestorIds, isWithin, parentOptions, wouldCreateLoop } from '@shared/hierarchy';
import { HistoryPanel } from '../../components/HistoryPanel';

export interface ResourceRow {
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
      <h1 className="text-3xl">Resources</h1>
      <p className="mt-1 text-sm text-gray-600">
        The halls, rooms and spaces people can book. To control when they can be booked, use{' '}
        <Link to="/admin/availability" className="font-bold text-scout-purple underline">opening hours &amp; rules</Link>,{' '}
        <Link to="/admin/availability/closures" className="font-bold text-scout-purple underline">closed periods</Link> and{' '}
        <Link to="/admin/availability/limits" className="font-bold text-scout-purple underline">booking limits</Link>.
      </p>

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
              {can('resources.manage') && <button className="btn-secondary" onClick={() => setEditing(r)}>Edit</button>}
            </div>
          </div>
        ))}
      </div>

      <ResourceHistory resources={rows} />

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
export function treeOrder(rows: ResourceRow[]): { row: ResourceRow; depth: number }[] {
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

/** Changes to one resource and everything recorded against it (prices, rules, closures, maintenance). */
function ResourceHistory({ resources }: { resources: ResourceRow[] }) {
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  return (
    <div>
      <div className="mt-8 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="rh-resource">Change history for</label>
          <select id="rh-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>
      {resourceId && <HistoryPanel key={resourceId} filters={{ resource_id: resourceId }} title={`${resources.find((r) => r.id === resourceId)?.name ?? 'Resource'} history`} />}
    </div>
  );
}
