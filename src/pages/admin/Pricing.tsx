import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { Spinner, ErrorState } from '../../components/ui';
import { formatGBP } from '@shared/pricing';

interface ResourceRow { id: string; name: string; }
interface PriceRow { id: string; category_id: string; category: string; label: string; amount_pence: number; is_free: boolean; }
interface ConflictRow { id: string; resource_id: string; conflicts_with_id: string; is_mandatory: boolean; }

export default function AdminPricing() {
  const { data: resources, loading, error } = useApi<ResourceRow[]>('/admin/resources');
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    if (resources && resources.length && !selected) setSelected(resources[0].id);
  }, [resources, selected]);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!resources) return null;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Pricing &amp; conflicts</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>

      <div className="card mt-6">
        <label className="label" htmlFor="res-select">Resource</label>
        <select id="res-select" className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      {selected && <PricingEditor resourceId={selected} />}
      <ConflictMatrix resources={resources} />
    </div>
  );
}

function PricingEditor({ resourceId }: { resourceId: string }) {
  const { data, loading, error } = useApi<PriceRow[]>(`/admin/resources/${resourceId}/pricing`, [resourceId]);
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => { if (data) setRows(data); }, [data]);

  async function save(row: PriceRow) {
    setSaving(row.category_id);
    setMsg(null);
    try {
      await api.put(`/admin/resources/${resourceId}/pricing`, {
        category_id: row.category_id,
        amount_pence: row.amount_pence,
        is_free: row.is_free,
      });
      setMsg(`Saved ${row.label} pricing. Existing bookings keep their original price.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="card mt-4">
      <h2 className="text-xl">Prices by category</h2>
      <p className="mt-1 text-xs text-gray-500">Amounts are entered in pence (e.g. 1000 = £10.00). Changes affect future bookings only.</p>
      <div className="mt-4 space-y-3">
        {rows.map((row, i) => (
          <div key={row.category_id} className="flex flex-wrap items-center gap-3">
            <span className="w-32 font-bold">{row.label}</span>
            <input
              type="number"
              min={0}
              className="input w-32"
              value={row.amount_pence}
              disabled={row.is_free}
              onChange={(e) => setRows(rows.map((r, j) => j === i ? { ...r, amount_pence: Number(e.target.value) } : r))}
            />
            <span className="text-sm text-gray-500">{formatGBP(row.amount_pence)}</span>
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={row.is_free}
                onChange={(e) => setRows(rows.map((r, j) => j === i ? { ...r, is_free: e.target.checked } : r))}
              />
              Free
            </label>
            <button className="btn-secondary" disabled={saving === row.category_id} onClick={() => save(row)}>Save</button>
          </div>
        ))}
      </div>
      {msg && <p className="mt-3 text-sm font-bold text-scout-green">{msg}</p>}
    </div>
  );
}

function ConflictMatrix({ resources }: { resources: ResourceRow[] }) {
  const { data, loading, error } = useApi<ConflictRow[]>('/admin/conflicts');
  const [edges, setEdges] = useState<ConflictRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => { if (data) setEdges(data); }, [data]);

  async function reload() {
    setEdges(await api.get<ConflictRow[]>('/admin/conflicts'));
  }

  function relation(a: string, b: string): ConflictRow | undefined {
    return edges.find((e) => e.resource_id === a && e.conflicts_with_id === b);
  }

  async function toggle(a: string, b: string, current?: ConflictRow) {
    if (a === b) return;
    setWorking(true);
    setMsg(null);
    try {
      if (current) {
        if (current.is_mandatory) {
          setMsg('Mandatory conflicts cannot be removed.');
          return;
        }
        await api.del('/admin/conflicts', { resource_id: a, conflicts_with_id: b });
      } else {
        await api.post('/admin/conflicts', { resource_id: a, conflicts_with_id: b });
      }
      await reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Update failed');
    } finally {
      setWorking(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="card mt-6 overflow-x-auto">
      <h2 className="text-xl">Conflict matrix</h2>
      <p className="mt-1 text-xs text-gray-500">
        A ticked cell means the two resources cannot be booked at the same time. Mandatory rules (shaded) cannot be removed.
        Changes do not affect existing bookings.
      </p>
      {msg && <p className="mt-2 text-sm font-bold text-scout-red">{msg}</p>}
      <table className="mt-4 min-w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="p-2 text-left"></th>
            {resources.map((r) => (
              <th key={r.id} className="p-2 text-center align-bottom">
                <span className="block max-w-[5rem] text-xs">{r.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {resources.map((row) => (
            <tr key={row.id}>
              <th className="p-2 text-left text-xs font-bold">{row.name}</th>
              {resources.map((col) => {
                const rel = relation(row.id, col.id);
                const self = row.id === col.id;
                return (
                  <td key={col.id} className={`border p-2 text-center ${rel?.is_mandatory ? 'bg-scout-off-white' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={`${row.name} conflicts with ${col.name}`}
                      checked={!!rel}
                      disabled={self || working || rel?.is_mandatory}
                      onChange={() => toggle(row.id, col.id, rel)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
