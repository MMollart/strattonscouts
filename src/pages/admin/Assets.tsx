import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { EmptyState, ErrorState, Spinner } from '../../components/ui';
import { formatLondon } from '@shared/londonTime';
import { ASSET_SETTABLE_STATUSES } from '@shared/assets';

interface AssetType {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  asset_count: number;
}

interface Asset {
  id: string;
  name: string;
  description: string | null;
  reference: string | null;
  status: string;
  asset_type_id: string;
  asset_type_name: string;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  assigned_user_email: string | null;
  assigned_at: string | null;
}

interface HistoryRow {
  id: string;
  user_name: string;
  user_email: string;
  assigned_at: string;
  assigned_by_name: string;
  assign_notes: string | null;
  returned_at: string | null;
  returned_by_name: string | null;
  return_notes: string | null;
  outcome: string | null;
}

interface UserRow {
  id: string;
  full_name: string;
  email: string;
}

const STATUS_LABEL: Record<string, string> = {
  available: 'Available', assigned: 'Assigned', lost: 'Lost', damaged: 'Damaged', retired: 'Retired',
};
const STATUS_STYLE: Record<string, string> = {
  available: 'bg-scout-green/15 text-scout-green',
  assigned: 'bg-scout-blue/15 text-scout-blue',
  lost: 'bg-scout-red/15 text-scout-red',
  damaged: 'bg-scout-yellow/30 text-yellow-800',
  retired: 'bg-gray-200 text-gray-600',
};
const OUTCOME_LABEL: Record<string, string> = { available: 'Returned', damaged: 'Returned damaged', lost: 'Reported lost' };

function AssetStatus({ status }: { status: string }) {
  return <span className={`badge ${STATUS_STYLE[status] ?? 'bg-gray-100 text-gray-700'}`}>{STATUS_LABEL[status] ?? status}</span>;
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Admin: keys, fobs, cards and equipment lent to registered users (FR07). */
export default function AdminAssets() {
  const [tab, setTab] = useState<'outstanding' | 'register' | 'types'>('outstanding');
  return (
    <div>
      <h1 className="text-3xl">Assets</h1>
      <div role="tablist" className="mt-4 flex flex-wrap gap-2">
        {([['outstanding', 'On loan'], ['register', 'Register'], ['types', 'Asset types']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'types' ? <Types /> : <Register key={tab} outstanding={tab === 'outstanding'} />}
    </div>
  );
}

function Register({ outstanding }: { outstanding: boolean }) {
  const { data: types } = useApi<AssetType[]>('/admin/asset-types');
  const [rows, setRows] = useState<Asset[] | null>(null);
  const [status, setStatus] = useState(outstanding ? 'assigned' : '');
  const [typeId, setTypeId] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (typeId) params.set('type_id', typeId);
    if (q.trim()) params.set('q', q.trim());
    try {
      setError(null);
      setRows(await api.get<Asset[]>(`/admin/assets?${params}`));
    } catch (e) {
      setError(message(e, 'Could not load assets'));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, typeId]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-end gap-3">
        {!outstanding && (
          <div>
            <label className="label" htmlFor="as-status">Status</label>
            <select id="as-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="as-type">Type</label>
          <select id="as-type" className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">All</option>
            {types?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <form className="grow" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <label className="label" htmlFor="as-q">Search</label>
          <input id="as-q" className="input" placeholder={outstanding ? 'Asset, reference or person' : 'Name, reference or holder'} value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => void load()} />
        </form>
        {!outstanding && <button className="btn-primary" onClick={() => setAdding(true)}>Add asset</button>}
      </div>

      {adding && types && <AssetForm types={types} onClose={() => setAdding(false)} onSaved={async (id) => { setAdding(false); await load(); setOpenId(id); }} />}
      {error && <div className="mt-3"><ErrorState message={error} /></div>}
      {!rows && !error && <Spinner />}
      {rows?.length === 0 && (
        <div className="mt-4">
          <EmptyState title={outstanding ? 'Nothing is on loan' : 'No assets found'}>
            {outstanding ? 'Assets you lend to people appear here until they are returned.' : 'Add keys, fobs, cards or equipment to start the register.'}
          </EmptyState>
        </div>
      )}
      <ul className="mt-4 space-y-2">
        {rows?.map((a) => (
          <li key={a.id} className="card">
            <button type="button" className="flex w-full flex-wrap items-start justify-between gap-2 text-left" aria-expanded={openId === a.id} onClick={() => setOpenId(openId === a.id ? null : a.id)}>
              <div>
                <p className="font-black">{a.name} {a.reference && <span className="font-normal text-gray-600">· {a.reference}</span>}</p>
                <p className="text-sm text-gray-600">
                  {a.asset_type_name}
                  {a.assigned_user_name && <> · with <strong>{a.assigned_user_name}</strong> since {formatLondon(a.assigned_at!, { dateStyle: 'medium' })}</>}
                </p>
              </div>
              <AssetStatus status={a.status} />
            </button>
            {openId === a.id && types && <AssetDetail id={a.id} types={types} onChanged={load} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssetForm({ types, asset, onClose, onSaved }: { types: AssetType[]; asset?: Asset; onClose: () => void; onSaved: (id: string) => void | Promise<void> }) {
  const active = types.filter((t) => t.is_active || t.id === asset?.asset_type_id);
  const [form, setForm] = useState({
    asset_type_id: asset?.asset_type_id ?? active[0]?.id ?? '',
    name: asset?.name ?? '',
    reference: asset?.reference ?? '',
    description: asset?.description ?? '',
    status: asset && asset.status !== 'assigned' ? asset.status : 'available',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const prefix = asset ? `edit-${asset.id}` : 'new-asset';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = { asset_type_id: form.asset_type_id, name: form.name, reference: form.reference || null, description: form.description || null };
    try {
      if (asset) {
        await api.put(`/admin/assets/${asset.id}`, asset.status === 'assigned' ? body : { ...body, status: form.status });
        await onSaved(asset.id);
      } else {
        const { id } = await api.post<{ id: string }>('/admin/assets', body);
        await onSaved(id);
      }
    } catch (err) {
      setError(message(err, 'Could not save the asset'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className={asset ? 'mt-3 space-y-3' : 'card mt-4 space-y-3'} aria-label={asset ? 'Edit asset' : 'Add asset'}>
      {!asset && <h2 className="text-xl">Add asset</h2>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${prefix}-name`}>Name</label>
          <input id={`${prefix}-name`} className="input" required maxLength={120} value={form.name} onChange={set('name')} />
        </div>
        <div>
          <label className="label" htmlFor={`${prefix}-type`}>Type</label>
          <select id={`${prefix}-type`} className="input" required value={form.asset_type_id} onChange={set('asset_type_id')}>
            {active.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${prefix}-ref`}>Serial or reference number (optional)</label>
          <input id={`${prefix}-ref`} className="input" maxLength={80} value={form.reference} onChange={set('reference')} />
        </div>
        {asset && (
          <div>
            <label className="label" htmlFor={`${prefix}-status`}>Status</label>
            {asset.status === 'assigned' ? (
              <p id={`${prefix}-status`} className="py-2 text-sm text-gray-600">Assigned. Record its return to change this.</p>
            ) : (
              <select id={`${prefix}-status`} className="input" value={form.status} onChange={set('status')}>
                {ASSET_SETTABLE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            )}
          </div>
        )}
      </div>
      <div>
        <label className="label" htmlFor={`${prefix}-desc`}>Description (optional)</label>
        <textarea id={`${prefix}-desc`} className="input" rows={2} maxLength={1000} value={form.description} onChange={set('description')} />
      </div>
      {error && <ErrorState message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={saving}>{asset ? 'Save changes' : 'Add asset'}</button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function AssetDetail({ id, types, onChanged }: { id: string; types: AssetType[]; onChanged: () => Promise<void> }) {
  const { data, loading, error, setData } = useApi<Asset & { history: HistoryRow[] }>(`/admin/assets/${id}`);
  const [editing, setEditing] = useState(false);
  if (loading) return <Spinner />;
  if (error || !data) return <ErrorState message={error ?? 'Not found'} />;
  const refresh = async () => {
    setData(await api.get<Asset & { history: HistoryRow[] }>(`/admin/assets/${id}`));
    await onChanged();
  };

  return (
    <div className="mt-3 border-t pt-3">
      {data.description && <p className="text-sm">{data.description}</p>}
      {editing ? (
        <AssetForm types={types} asset={data} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} />
      ) : (
        <button className="btn-secondary mt-2" onClick={() => setEditing(true)}>Edit details</button>
      )}

      {data.status === 'assigned' ? <ReturnForm asset={data} onDone={refresh} /> : <AssignForm asset={data} onDone={refresh} />}

      <h3 className="mt-4 font-black">History</h3>
      {data.history.length === 0 ? (
        <p className="text-sm text-gray-600">Never assigned.</p>
      ) : (
        <ol className="mt-2 space-y-2 text-sm">
          {data.history.map((h) => (
            <li key={h.id} className="rounded-lg bg-gray-50 p-2">
              <p>
                <strong>{h.user_name}</strong> <span className="text-gray-600">({h.user_email})</span>
              </p>
              <p className="text-gray-700">
                Assigned {formatLondon(h.assigned_at)} by {h.assigned_by_name}
                {h.assign_notes && <> · “{h.assign_notes}”</>}
              </p>
              {h.returned_at ? (
                <p className="text-gray-700">
                  {OUTCOME_LABEL[h.outcome ?? 'available']} {formatLondon(h.returned_at)} by {h.returned_by_name}
                  {h.return_notes && <> · “{h.return_notes}”</>}
                </p>
              ) : (
                <p className="font-bold text-scout-blue">Still on loan</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AssignForm({ asset, onDone }: { asset: Asset; onDone: () => Promise<void> }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [userId, setUserId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const assignable = asset.status === 'available' || asset.status === 'damaged';

  useEffect(() => {
    if (!assignable) return;
    api.get<UserRow[]>('/admin/users').then(setUsers).catch((e) => setError(message(e, 'Could not load users')));
  }, [assignable]);

  if (!assignable) {
    return <p className="mt-3 text-sm text-gray-600">{STATUS_LABEL[asset.status]} assets cannot be assigned. Change its status to lend it again.</p>;
  }
  const matches = (users ?? []).filter((u) => `${u.full_name} ${u.email}`.toLowerCase().includes(filter.trim().toLowerCase()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return setError('Choose who it is going to');
    setSaving(true);
    setError(null);
    try {
      await api.post(`/admin/assets/${asset.id}/assign`, { user_id: userId, notes: notes || null });
      await onDone();
    } catch (err) {
      setError(message(err, 'Could not assign the asset'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border p-3" aria-label="Assign asset">
      <h3 className="font-black">Assign to someone</h3>
      {asset.status === 'damaged' && <p className="text-sm text-yellow-800">This asset is marked damaged.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`as-find-${asset.id}`}>Find person</label>
          <input id={`as-find-${asset.id}`} className="input" placeholder="Name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`as-user-${asset.id}`}>Registered user</label>
          <select id={`as-user-${asset.id}`} className="input" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">{users ? `Select (${matches.length})` : 'Loading…'}</option>
            {matches.slice(0, 200).map((u) => <option key={u.id} value={u.id}>{u.full_name} · {u.email}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`as-notes-${asset.id}`}>Notes (optional)</label>
        <input id={`as-notes-${asset.id}`} className="input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <ErrorState message={error} />}
      <button className="btn-teal" disabled={saving}>Record assignment</button>
    </form>
  );
}

function ReturnForm({ asset, onDone }: { asset: Asset; onDone: () => Promise<void> }) {
  const [outcome, setOutcome] = useState<'available' | 'damaged' | 'lost'>('available');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post(`/admin/assets/${asset.id}/return`, { outcome, notes: notes || null });
      await onDone();
    } catch (err) {
      setError(message(err, 'Could not record the return'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border p-3" aria-label="Record return">
      <h3 className="font-black">With {asset.assigned_user_name}</h3>
      <p className="text-sm text-gray-600">{asset.assigned_user_email} · since {formatLondon(asset.assigned_at!)}</p>
      <fieldset>
        <legend className="label">Outcome</legend>
        <div className="flex flex-wrap gap-3">
          {(['available', 'damaged', 'lost'] as const).map((o) => (
            <label key={o} className="flex items-center gap-1">
              <input type="radio" name={`outcome-${asset.id}`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
              {OUTCOME_LABEL[o]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor={`ret-notes-${asset.id}`}>Notes (optional)</label>
        <input id={`ret-notes-${asset.id}`} className="input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <ErrorState message={error} />}
      <button className={outcome === 'lost' ? 'btn-danger' : 'btn-teal'} disabled={saving}>{outcome === 'lost' ? 'Record as lost' : 'Record return'}</button>
    </form>
  );
}

function Types() {
  const { data, loading, error, setData } = useApi<AssetType[]>('/admin/asset-types');
  const [editing, setEditing] = useState<string | null>(null);
  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const reload = async () => setData(await api.get<AssetType[]>('/admin/asset-types'));
  return (
    <div className="mt-6 space-y-2">
      {data?.map((t) =>
        editing === t.id ? (
          <TypeForm key={t.id} type={t} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
        ) : (
          <div key={t.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-black">{t.name} {!t.is_active && <span className="badge bg-gray-200 text-gray-600">retired</span>}</p>
              <p className="text-sm text-gray-600">{t.description ?? 'No description'} · {t.asset_count} {t.asset_count === 1 ? 'asset' : 'assets'}</p>
            </div>
            <button className="btn-secondary" onClick={() => setEditing(t.id)}>Edit</button>
          </div>
        ),
      )}
      {editing === 'new' ? (
        <TypeForm onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
      ) : (
        <button className="btn-primary" onClick={() => setEditing('new')}>Add asset type</button>
      )}
    </div>
  );
}

function TypeForm({ type, onClose, onSaved }: { type?: AssetType; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [sortOrder, setSortOrder] = useState(type?.sort_order ?? 0);
  const [active, setActive] = useState(type?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const prefix = type ? `type-${type.id}` : 'type-new';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name, description: description || null, sort_order: sortOrder, is_active: active };
    try {
      if (type) await api.put(`/admin/asset-types/${type.id}`, body);
      else await api.post('/admin/asset-types', body);
      await onSaved();
    } catch (err) {
      setError(message(err, 'Could not save the asset type'));
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3" aria-label={type ? `Edit ${type.name}` : 'Add asset type'}>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div>
          <label className="label" htmlFor={`${prefix}-name`}>Name</label>
          <input id={`${prefix}-name`} className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`${prefix}-order`}>Order</label>
          <input id={`${prefix}-order`} type="number" min={0} className="input" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`${prefix}-desc`}>Description (optional)</label>
        <input id={`${prefix}-desc`} className="input" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        In use (retired types keep their assets but cannot be chosen for new ones)
      </label>
      {error && <ErrorState message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary">Save</button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
