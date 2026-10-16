import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { ErrorState, Spinner } from '../../components/ui';
import { formatGBP } from '@shared/pricing';
import { formatLondon, londonToday } from '@shared/londonTime';
import { FINANCE_STATUS_LABEL, type FinanceStatus } from '@shared/finance';

interface Bucket {
  value_pence: number;
  count: number;
  average_pence: number;
}
interface BreakdownRow {
  key: string;
  label: string;
  totals: Record<FinanceStatus, { value_pence: number; count: number }>;
}
interface Point {
  key: string;
  confirmed: number;
  provisional: number;
  pending_approval: number;
}
interface Report {
  period: { preset: string; from: string; to: string };
  basis: 'usage' | 'booked';
  note: string;
  totals: Record<FinanceStatus, Bucket>;
  discounts: {
    total_discount_pence: number;
    list_price_pence: number;
    discounted_count: number;
    free_count: number;
  };
  by_resource: BreakdownRow[];
  by_category: BreakdownRow[];
  by_organisation: BreakdownRow[];
  series: { unit: 'day' | 'month'; points: Point[] };
}
interface Option {
  id: string;
  name: string;
  label?: string;
}

const PRESETS = [
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['this_year', 'This year'],
  ['last_year', 'Last year'],
  ['custom', 'Custom dates'],
] as const;

const BAR = '#7413dc'; // Scouts purple: one series, so one hue.

/** Admin: booking values by period, resource, price group and organisation (FR10). */
export default function AdminFinance() {
  const { can } = useAuth();
  const { data: resources } = useApi<Option[]>('/admin/resources');
  const { data: categories } = useApi<Option[]>('/categories');
  const { data: organisations } = useApi<Option[]>('/admin/organisations');
  const [preset, setPreset] = useState('this_month');
  const [from, setFrom] = useState(() => `${londonToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(londonToday());
  const [basis, setBasis] = useState<'usage' | 'booked'>('usage');
  const [resourceId, setResourceId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [organisationId, setOrganisationId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams({ period: preset, basis });
    if (preset === 'custom') {
      q.set('from', from);
      q.set('to', to);
    }
    if (resourceId) q.set('resource_id', resourceId);
    if (categoryId) q.set('category_id', categoryId);
    if (organisationId) q.set('organisation_id', organisationId);
    return q.toString();
  }, [preset, from, to, basis, resourceId, categoryId, organisationId]);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .get<Report>(`/admin/finance?${query}`)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not load the report'));
    return () => {
      live = false;
    };
  }, [query]);

  const day = (d: string) =>
    formatLondon(`${d}T12:00:00Z`, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

  return (
    <div>
      <h1 className="text-3xl">Booking values</h1>
      <p className="mt-2 rounded-lg bg-scout-yellow/20 px-4 py-2 text-sm text-yellow-900">
        These are the values of bookings, worked out from the price fixed on each booking. They are <strong>not payments received</strong>.
      </p>

      <div className="card mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="fin-period">
            Period
          </label>
          <select id="fin-period" className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {preset === 'custom' && (
          <>
            <div>
              <label className="label" htmlFor="fin-from">
                From (UK date)
              </label>
              <input id="fin-from" type="date" className="input" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="fin-to">
                To (UK date)
              </label>
              <input id="fin-to" type="date" className="input" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </div>
          </>
        )}
        <div>
          <label className="label" htmlFor="fin-basis">
            Count value on
          </label>
          <select id="fin-basis" className="input" value={basis} onChange={(e) => setBasis(e.target.value as 'usage' | 'booked')}>
            <option value="usage">The days it is used</option>
            <option value="booked">The day it was booked</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="fin-resource">
            Resource
          </label>
          <select id="fin-resource" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
            <option value="">All</option>
            {resources?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="fin-category">
            Price group
          </label>
          <select id="fin-category" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label ?? c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="fin-org">
            Organisation
          </label>
          <select id="fin-org" className="input" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
            <option value="">All</option>
            <option value="none">Personal bookings only</option>
            {organisations?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        {can('finance.export') && (
          <div className="self-end">
            <a className="btn-secondary inline-block" href={`/api/admin/finance/export?${query}`}>
              Export CSV
            </a>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorState message={error} />
        </div>
      )}
      {!report && !error && <Spinner />}
      {report && (
        <>
          <h2 className="mt-6 text-xl" aria-live="polite">
            {day(report.period.from)} to {day(report.period.to)}
            <span className="block text-sm font-normal text-gray-600">
              {report.basis === 'usage'
                ? 'Value counted on the days each booking is used; bookings over several days are shared between them by time.'
                : 'Each booking’s whole value counted on the day it was made.'}
            </span>
          </h2>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile title="Confirmed" bucket={report.totals.confirmed} emphasis />
            <Tile title="Provisional" bucket={report.totals.provisional} />
            <Tile title="Awaiting approval" bucket={report.totals.pending_approval} />
            <Tile title="Cancelled" bucket={report.totals.cancelled} />
          </div>
          <p className="mt-2 text-sm text-gray-600">
            Not counted in any total above: rejected {formatGBP(report.totals.rejected.value_pence)} ({report.totals.rejected.count}), expired provisional holds{' '}
            {formatGBP(report.totals.expired.value_pence)} ({report.totals.expired.count}).
          </p>

          <div className="card mt-3 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Discounts given on confirmed bookings"
              value={formatGBP(report.discounts.total_discount_pence)}
              detail={`from list prices of ${formatGBP(report.discounts.list_price_pence)}`}
            />
            <Stat label="Discounted confirmed bookings" value={String(report.discounts.discounted_count)} />
            <Stat label="Free confirmed bookings" value={String(report.discounts.free_count)} />
          </div>

          <ValueChart series={report.series} />

          <Breakdown title="By resource" rows={report.by_resource} />
          <Breakdown title="By price group" rows={report.by_category} />
          <Breakdown title="By organisation" rows={report.by_organisation} searchable />
        </>
      )}
    </div>
  );
}

function Tile({ title, bucket, emphasis }: { title: string; bucket: Bucket; emphasis?: boolean }) {
  return (
    <div className={`card ${emphasis ? 'border-l-4 border-scout-purple' : ''}`}>
      <p className="text-sm font-bold text-gray-600">{title}</p>
      <p className="text-3xl font-black">{formatGBP(bucket.value_pence)}</p>
      <p className="text-sm text-gray-600">
        {bucket.count} booking{bucket.count === 1 ? '' : 's'}
        {bucket.count ? `, average ${formatGBP(bucket.average_pence)}` : ''}
      </p>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <p className="text-sm font-bold text-gray-600">{label}</p>
      <p className="text-2xl font-black">{value}</p>
      {detail && <p className="text-xs text-gray-500">{detail}</p>}
    </div>
  );
}

/** Compact pounds for axis ticks: £0, £500, £1.5K. */
function compact(pence: number): string {
  const p = pence / 100;
  if (p >= 1000) return `£${(p / 1000).toFixed(p % 1000 === 0 ? 0 : 1)}K`;
  return `£${Math.round(p)}`;
}

function niceMax(v: number): number {
  if (v <= 0) return 10_000;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v)!;
  return step * mag;
}

/** Confirmed value over time: one series of columns, with a hover tooltip and a table view. */
function ValueChart({ series }: { series: Report['series'] }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const points = series.points;
  const label = (k: string) =>
    series.unit === 'month'
      ? formatLondon(`${k}-15T12:00:00Z`, { month: 'short', year: 'numeric' })
      : formatLondon(`${k}T12:00:00Z`, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });

  const W = 720;
  const H = 240;
  const pad = { l: 52, r: 8, t: 12, b: 28 };
  const max = niceMax(Math.max(0, ...points.map((p) => p.confirmed)));
  const band = (W - pad.l - pad.r) / Math.max(1, points.length);
  const barW = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const every = Math.ceil(points.length / 8);

  return (
    <section className="card mt-4" aria-labelledby="fin-chart-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="fin-chart-heading" className="text-lg font-black">
          Confirmed booking value by {series.unit}
        </h3>
        <button type="button" className="text-sm font-bold text-scout-purple" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {asTable ? (
        <div className="mt-3 max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600">
                <th className="py-1">{series.unit === 'month' ? 'Month' : 'Day'}</th>
                <th className="py-1 text-right">Confirmed</th>
                <th className="py-1 text-right">Provisional</th>
                <th className="py-1 text-right">Awaiting approval</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key} className="border-t">
                  <td className="py-1">{label(p.key)}</td>
                  <td className="py-1 text-right">{formatGBP(p.confirmed)}</td>
                  <td className="py-1 text-right">{formatGBP(p.provisional)}</td>
                  <td className="py-1 text-right">{formatGBP(p.pending_approval)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <div className="relative min-w-[40rem]">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full"
              role="img"
              aria-label={`Column chart of confirmed booking value by ${series.unit}. Use "Show as table" for the figures.`}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
                  <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#6b7280">
                    {compact(t)}
                  </text>
                </g>
              ))}
              {points.map((p, i) => {
                const x = pad.l + i * band + (band - barW) / 2;
                const top = y(p.confirmed);
                const h = H - pad.b - top;
                const r = Math.min(4, barW / 2, h);
                return (
                  <g
                    key={p.key}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    tabIndex={0}
                    aria-label={`${label(p.key)}: ${formatGBP(p.confirmed)}`}
                  >
                    {/* A hit area the full height of the band, wider than the bar. */}
                    <rect x={pad.l + i * band} y={pad.t} width={band} height={H - pad.t - pad.b} fill="transparent" />
                    {h > 0 && (
                      <path
                        d={`M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${H - pad.b} Z`}
                        fill={BAR}
                        opacity={hover === null || hover === i ? 1 : 0.5}
                      />
                    )}
                    {i % every === 0 && (
                      <text x={pad.l + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="#6b7280">
                        {series.unit === 'month'
                          ? formatLondon(`${p.key}-15T12:00:00Z`, {
                              month: 'short',
                            })
                          : formatLondon(`${p.key}T12:00:00Z`, {
                              day: 'numeric',
                              month: 'short',
                            })}
                      </text>
                    )}
                  </g>
                );
              })}
              <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="#d1d5db" strokeWidth={1} />
            </svg>
            {hover !== null && points[hover] && (
              <div
                className="pointer-events-none absolute top-0 max-w-[18rem] rounded-lg border bg-white px-3 py-2 text-sm shadow"
                style={{
                  left: `${Math.min(80, ((pad.l + hover * band) / W) * 100)}%`,
                }}
                role="status"
              >
                <p className="font-bold">{label(points[hover].key)}</p>
                <p>
                  <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: BAR }} aria-hidden />
                  Confirmed {formatGBP(points[hover].confirmed)}
                </p>
                <p className="text-gray-600">
                  Provisional {formatGBP(points[hover].provisional)} · Awaiting approval {formatGBP(points[hover].pending_approval)}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Breakdown({ title, rows, searchable }: { title: string; rows: BreakdownRow[]; searchable?: boolean }) {
  const [q, setQ] = useState('');
  const shown = rows.filter((r) => !q.trim() || r.label.toLowerCase().includes(q.trim().toLowerCase()));
  const max = Math.max(1, ...rows.map((r) => r.totals.confirmed.value_pence));
  const id = title.toLowerCase().replace(/\s+/g, '-');
  return (
    <section className="card mt-4" aria-labelledby={`fin-${id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`fin-${id}`} className="text-lg font-black">
          {title}
        </h3>
        {searchable && (
          <input
            className="input w-auto"
            type="search"
            placeholder="Search organisations"
            aria-label="Search organisations"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </div>
      {shown.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No bookings in this period.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="text-left text-gray-600">
                <th className="py-1">Name</th>
                <th className="py-1 text-right">Confirmed</th>
                <th className="py-1 text-right">Bookings</th>
                <th className="py-1 text-right">{FINANCE_STATUS_LABEL.provisional}</th>
                <th className="py-1 text-right">{FINANCE_STATUS_LABEL.pending_approval}</th>
                <th className="py-1 text-right">{FINANCE_STATUS_LABEL.cancelled}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} className="border-t">
                  <td className="py-1.5">
                    {r.label}
                    <span
                      className="mt-1 block h-1.5 rounded-full"
                      style={{
                        width: `${(r.totals.confirmed.value_pence / max) * 100}%`,
                        background: BAR,
                      }}
                      aria-hidden
                    />
                  </td>
                  <td className="py-1.5 text-right font-bold">{formatGBP(r.totals.confirmed.value_pence)}</td>
                  <td className="py-1.5 text-right">{r.totals.confirmed.count}</td>
                  <td className="py-1.5 text-right">{formatGBP(r.totals.provisional.value_pence)}</td>
                  <td className="py-1.5 text-right">{formatGBP(r.totals.pending_approval.value_pence)}</td>
                  <td className="py-1.5 text-right">{formatGBP(r.totals.cancelled.value_pence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
