import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';

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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
      <form className="card my-8 w-full max-w-lg space-y-4" onSubmit={save}>
        <h2 className="text-2xl">{form.id ? 'Edit resource' : 'New resource'}</h2>
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
    </div>
  );
}
