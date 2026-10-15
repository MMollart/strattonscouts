import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { formatGBP, formatPercent, RATE_MODEL_LABEL, type RateModel } from '@shared/pricing';
import { formatLondon, fromLondon, londonToday } from '@shared/londonTime';
import { poundsToPence } from '../../lib/money';

interface ResourceRow { id: string; name: string; }
interface ConflictRow { id: string; resource_id: string; conflicts_with_id: string; is_mandatory: boolean; }
interface CategoryRow { id: string; name: string; label: string; sort_order: number; is_active: boolean; }
interface RateRow {
  id: string; resource_id: string; category_id: string; category_label: string; pricing_model: RateModel;
  amount_pence: number; effective_from: string; effective_to: string | null; is_active: boolean;
}
interface DiscountRow {
  id: string; name: string; discount_type: 'percentage' | 'fixed'; value: number; resource_id: string | null;
  resource_name: string | null; category_id: string | null; category_label: string | null;
  effective_from: string; effective_to: string | null; is_active: boolean;
}

type Tab = 'rates' | 'discounts' | 'categories' | 'organisations' | 'conflicts';

/** A London calendar date as the start-of-day instant, or null for blank. */
function dateToIso(date: string): string | null {
  return date ? fromLondon(date, '00:00') : null;
}
function period(from: string, to: string | null): string {
  const f = from.startsWith('1970') ? 'Always' : `From ${formatLondon(from, { dateStyle: 'medium' })}`;
  return to ? `${f} until ${formatLondon(to, { dateStyle: 'medium' })}` : f;
}

export default function AdminPricing() {
  const { data: resources, loading, error } = useApi<ResourceRow[]>('/admin/resources');
  const { data: categories, setData: setCategories } = useApi<CategoryRow[]>('/admin/categories');
  const [tab, setTab] = useState<Tab>('rates');

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!resources) return null;

  const tabs: [Tab, string][] = [
    ['rates', 'Rates'],
    ['discounts', 'Discounts'],
    ['organisations', 'Organisation pricing'],
    ['categories', 'Categories'],
    ['conflicts', 'Conflict matrix'],
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Pricing &amp; conflicts</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>
      <p className="mt-2 text-sm text-gray-600">Changes apply to bookings priced from now on. Existing bookings keep the price agreed when they were made.</p>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'rates' && <RatesPanel resources={resources} categories={categories ?? []} />}
      {tab === 'discounts' && <DiscountsPanel resources={resources} categories={categories ?? []} />}
      {tab === 'organisations' && <OrganisationPricingPanel resources={resources} />}
      {tab === 'categories' && (
        <CategoriesPanel
          categories={categories ?? []}
          reload={async () => setCategories(await api.get<CategoryRow[]>('/admin/categories'))}
        />
      )}
      {tab === 'conflicts' && <ConflictMatrix resources={resources} />}
    </div>
  );
}

/** Placeholder until FR14 adds organisation-specific pricing. */
function OrganisationPricingPanel(_props: { resources: ResourceRow[] }) {
  return <EmptyState title="Organisation pricing">Organisation-specific arrangements are not available yet.</EmptyState>;
}

function useFeedback() {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const node = msg && (
    <p className={`mt-3 text-sm font-bold ${msg.kind === 'ok' ? 'text-scout-green' : 'text-scout-red'}`} role={msg.kind === 'ok' ? 'status' : 'alert'}>
      {msg.text}
    </p>
  );
  return {
    node,
    ok: (text: string) => setMsg({ kind: 'ok', text }),
    fail: (e: unknown, fallback: string) => setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : fallback }),
    clear: () => setMsg(null),
  };
}

function RatesPanel({ resources, categories }: { resources: ResourceRow[]; categories: CategoryRow[] }) {
  const { can } = useAuth();
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const { data, loading, error, setData } = useApi<RateRow[]>(`/admin/pricing/rates?resource_id=${resourceId}`, [resourceId]);
  const fb = useFeedback();
  const [draft, setDraft] = useState({ category_id: '', pricing_model: 'hourly' as RateModel, amount: '', from: londonToday(), to: '' });
  const [saving, setSaving] = useState(false);
  const canEdit = can('pricing.manage');

  async function reload() {
    setData(await api.get<RateRow[]>(`/admin/pricing/rates?resource_id=${resourceId}`));
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    fb.clear();
    const pence = draft.pricing_model === 'free' ? 0 : poundsToPence(draft.amount);
    if (pence === null) return fb.fail(null, 'Enter the amount in pounds, e.g. 12.50');
    setSaving(true);
    try {
      await api.post('/admin/pricing/rates', {
        resource_id: resourceId,
        category_id: draft.category_id || categories[0]?.id,
        pricing_model: draft.pricing_model,
        amount_pence: pence,
        effective_from: dateToIso(draft.from),
        effective_to: dateToIso(draft.to),
      });
      await reload();
      fb.ok('Rate added.');
      setDraft((d) => ({ ...d, amount: '' }));
    } catch (err) {
      fb.fail(err, 'Could not add the rate');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: RateRow) {
    fb.clear();
    try {
      await api.put(`/admin/pricing/rates/${r.id}`, { ...r, is_active: !r.is_active });
      await reload();
    } catch (err) {
      fb.fail(err, 'Could not update the rate');
    }
  }

  async function remove(r: RateRow) {
    if (!confirm('Delete this rate? Existing bookings keep their agreed price.')) return;
    try {
      await api.del(`/admin/pricing/rates/${r.id}`);
      await reload();
    } catch (err) {
      fb.fail(err, 'Could not delete the rate');
    }
  }

  return (
    <section className="card mt-4">
      <div className="max-w-sm">
        <label className="label" htmlFor="rate-resource">Resource</label>
        <select id="rate-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
          {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        For each category the newest rate whose period covers the booking start is used. A booking with no matching rate cannot be made.
      </p>
      {loading && <Spinner />}
      {error && <ErrorState message={error} />}
      {data && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-gray-500"><th className="p-2">Category</th><th className="p-2">Price</th><th className="p-2">Period</th><th className="p-2"></th></tr></thead>
            <tbody>
              {data.length === 0 && <tr><td className="p-2 text-gray-500" colSpan={4}>No rates yet. Customers cannot book this resource until a rate exists.</td></tr>}
              {data.map((r) => (
                <tr key={r.id} className={`border-t ${r.is_active ? '' : 'opacity-50'}`}>
                  <td className="p-2 font-bold">{r.category_label}</td>
                  <td className="p-2">{r.pricing_model === 'free' ? 'Free' : `${formatGBP(r.amount_pence)} ${RATE_MODEL_LABEL[r.pricing_model]}`}</td>
                  <td className="p-2">{period(r.effective_from, r.effective_to)}{!r.is_active && ' (disabled)'}</td>
                  <td className="p-2 text-right">
                    {canEdit && (
                      <span className="flex justify-end gap-2">
                        <button className="text-scout-purple underline" onClick={() => toggle(r)}>{r.is_active ? 'Disable' : 'Enable'}</button>
                        <button className="text-scout-red underline" onClick={() => remove(r)}>Delete</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && (
        <form className="mt-6 grid gap-3 border-t pt-4 sm:grid-cols-3 lg:grid-cols-6 lg:items-end" onSubmit={add}>
          <div>
            <label className="label" htmlFor="rate-cat">Category</label>
            <select id="rate-cat" className="input" value={draft.category_id || categories[0]?.id || ''} onChange={(e) => setDraft({ ...draft, category_id: e.target.value })}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rate-model">Charging</label>
            <select id="rate-model" className="input" value={draft.pricing_model} onChange={(e) => setDraft({ ...draft, pricing_model: e.target.value as RateModel })}>
              <option value="hourly">Per hour</option>
              <option value="nightly">Per night</option>
              <option value="fixed">Fixed per booking</option>
              <option value="free">Free</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rate-amount">Amount (£)</label>
            <input id="rate-amount" className="input" inputMode="decimal" value={draft.pricing_model === 'free' ? '0.00' : draft.amount} disabled={draft.pricing_model === 'free'} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="rate-from">Effective from</label>
            <input id="rate-from" type="date" className="input" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="rate-to">Until (optional)</label>
            <input id="rate-to" type="date" className="input" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <button className="btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add rate'}</button>
        </form>
      )}
      {fb.node}
    </section>
  );
}

function DiscountsPanel({ resources, categories }: { resources: ResourceRow[]; categories: CategoryRow[] }) {
  const { can } = useAuth();
  const { data, loading, error, setData } = useApi<DiscountRow[]>('/admin/pricing/discounts');
  const fb = useFeedback();
  const empty = { name: '', discount_type: 'percentage' as 'percentage' | 'fixed', value: '', resource_id: '', category_id: '', from: londonToday(), to: '' };
  const [draft, setDraft] = useState(empty);
  const canEdit = can('pricing.manage');

  async function reload() {
    setData(await api.get<DiscountRow[]>('/admin/pricing/discounts'));
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    fb.clear();
    const value = draft.discount_type === 'percentage' ? Math.round(Number(draft.value) * 100) : poundsToPence(draft.value);
    if (value === null || !Number.isFinite(value) || value < 0) return fb.fail(null, 'Enter a valid amount');
    try {
      await api.post('/admin/pricing/discounts', {
        name: draft.name,
        discount_type: draft.discount_type,
        value,
        resource_id: draft.resource_id || null,
        category_id: draft.category_id || null,
        effective_from: dateToIso(draft.from),
        effective_to: dateToIso(draft.to),
      });
      await reload();
      setDraft(empty);
      fb.ok('Discount added.');
    } catch (err) {
      fb.fail(err, 'Could not add the discount');
    }
  }

  async function toggle(d: DiscountRow) {
    try {
      await api.put(`/admin/pricing/discounts/${d.id}`, { ...d, is_active: !d.is_active });
      await reload();
    } catch (err) {
      fb.fail(err, 'Could not update the discount');
    }
  }

  async function remove(d: DiscountRow) {
    if (!confirm(`Delete "${d.name}"? Existing bookings keep their agreed price.`)) return;
    await api.del(`/admin/pricing/discounts/${d.id}`).catch((err) => fb.fail(err, 'Could not delete'));
    await reload();
  }

  return (
    <section className="card mt-4">
      <p className="text-sm text-gray-600">
        Discounts apply to the standard category rate. When several match a booking, the one giving the largest saving applies; they never stack.
        Organisation-specific arrangements take precedence over general discounts.
      </p>
      {loading && <Spinner />}
      {error && <ErrorState message={error} />}
      <div className="mt-4 space-y-2">
        {data?.length === 0 && <p className="text-sm text-gray-500">No discounts.</p>}
        {data?.map((d) => (
          <div key={d.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 ${d.is_active ? '' : 'opacity-50'}`}>
            <div>
              <p className="font-bold">{d.name}: {d.discount_type === 'percentage' ? formatPercent(d.value) : formatGBP(d.value)} off</p>
              <p className="text-xs text-gray-500">
                {d.resource_name ?? 'All resources'} · {d.category_label ?? 'All categories'} · {period(d.effective_from, d.effective_to)}
              </p>
            </div>
            {canEdit && (
              <span className="flex gap-3 text-sm">
                <button className="text-scout-purple underline" onClick={() => toggle(d)}>{d.is_active ? 'Disable' : 'Enable'}</button>
                <button className="text-scout-red underline" onClick={() => remove(d)}>Delete</button>
              </span>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <form className="mt-6 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={add}>
          <div className="lg:col-span-2">
            <label className="label" htmlFor="d-name">Name (shown to customers)</label>
            <input id="d-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required minLength={2} />
          </div>
          <div>
            <label className="label" htmlFor="d-type">Type</label>
            <select id="d-type" className="input" value={draft.discount_type} onChange={(e) => setDraft({ ...draft, discount_type: e.target.value as 'percentage' | 'fixed' })}>
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed amount</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="d-value">{draft.discount_type === 'percentage' ? 'Percent off' : 'Amount off (£)'}</label>
            <input id="d-value" className="input" inputMode="decimal" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="d-res">Resource</label>
            <select id="d-res" className="input" value={draft.resource_id} onChange={(e) => setDraft({ ...draft, resource_id: e.target.value })}>
              <option value="">All resources</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="d-cat">Category</label>
            <select id="d-cat" className="input" value={draft.category_id} onChange={(e) => setDraft({ ...draft, category_id: e.target.value })}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="d-from">Effective from</label>
            <input id="d-from" type="date" className="input" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="d-to">Until (optional)</label>
            <input id="d-to" type="date" className="input" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <button className="btn-primary lg:col-span-4">Add discount</button>
        </form>
      )}
      {fb.node}
    </section>
  );
}

function CategoriesPanel({ categories, reload }: { categories: CategoryRow[]; reload: () => Promise<void> }) {
  const { can } = useAuth();
  const fb = useFeedback();
  const [label, setLabel] = useState('');
  const canEdit = can('pricing.manage');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    fb.clear();
    const name = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    try {
      await api.post('/admin/categories', { name, label: label.trim(), sort_order: (categories.length + 1) * 10 });
      setLabel('');
      await reload();
      fb.ok('Category added. Add rates for it so its customers can book.');
    } catch (err) {
      fb.fail(err, 'Could not add the category');
    }
  }

  async function toggle(c: CategoryRow) {
    try {
      await api.put(`/admin/categories/${c.id}`, { label: c.label, sort_order: c.sort_order, is_active: !c.is_active });
      await reload();
    } catch (err) {
      fb.fail(err, 'Could not update the category');
    }
  }

  return (
    <section className="card mt-4">
      <p className="text-sm text-gray-600">Retired categories are hidden from registration; existing customers and bookings keep them.</p>
      <ul className="mt-4 divide-y rounded-xl border">
        {categories.map((c) => (
          <li key={c.id} className={`flex items-center justify-between px-4 py-3 ${c.is_active ? '' : 'opacity-50'}`}>
            <span className="font-bold">{c.label}{!c.is_active && ' (retired)'}</span>
            {canEdit && <button className="text-sm text-scout-purple underline" onClick={() => toggle(c)}>{c.is_active ? 'Retire' : 'Reinstate'}</button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="mt-4 flex flex-wrap gap-2" onSubmit={add}>
          <label className="sr-only" htmlFor="cat-label">New category name</label>
          <input id="cat-label" className="input max-w-sm" placeholder="e.g. Schools" value={label} onChange={(e) => setLabel(e.target.value)} required minLength={2} />
          <button className="btn-primary">Add category</button>
        </form>
      )}
      {fb.node}
    </section>
  );
}

// Retained from Release 1.
function ConflictMatrix({ resources }: { resources: ResourceRow[] }) {
  const { can } = useAuth();
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
                      disabled={self || working || rel?.is_mandatory || !can('resources.manage')}
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
