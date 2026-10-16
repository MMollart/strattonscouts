import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { ErrorState, Spinner, StatusBadge } from '../../components/ui';
import { BookForCustomer } from './Bookings';
import { calendarRange, dayPosition, onDay, shiftDate, type CalendarView } from '@shared/calendar';
import { formatLondon, londonToday } from '@shared/londonTime';
import { formatGBP } from '@shared/pricing';

interface Booking {
  id: string;
  reference: string;
  status: string;
  starts_at: string;
  ends_at: string;
  resource_id: string;
  resource_name: string;
  customer_name: string;
  customer_email: string;
  user_id: string;
  organisation_id: string | null;
  organisation_name: string | null;
  series_id: string | null;
  expires_at: string | null;
  total_amount_pence: number;
}

interface Resource { id: string; name: string; is_active: boolean }
interface Closure { id: string; resource_id: string; starts_at: string; ends_at: string; reason: string | null; maintenance_id?: string | null }
interface Maintenance {
  id: string;
  reference: string;
  resource_id: string;
  resource_name: string;
  maintenance_type_label: string;
  title: string;
  starts_at: string;
  ends_at: string;
  status: string;
  blocks_availability: boolean;
}
interface MaintenanceType { id: string; label: string }

/** Maintenance is drawn in orange stripes so it never looks like a booking or a plain closure (FR22 §4.8). */
const MAINTENANCE_STYLE = 'border-2 border-scout-orange bg-[repeating-linear-gradient(135deg,#ffe3c7_0,#ffe3c7_6px,#fff4e8_6px,#fff4e8_12px)] text-orange-900';
interface Organisation { id: string; name: string }

const PALETTE = ['#7413dc', '#00a794', '#006ddf', '#e22e12', '#205b41', '#003982', '#c2185b', '#8a6d00'];

/** Booking statuses are told apart by fill and border, not only colour. */
const STATUS_STYLE: Record<string, string> = {
  confirmed: 'border-solid opacity-100',
  pending_approval: 'border-dashed opacity-90',
  provisional: 'border-dotted opacity-80',
  cancelled: 'border-solid opacity-40 line-through',
  rejected: 'border-solid opacity-40 line-through',
  expired: 'border-solid opacity-40 line-through',
};
const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed', pending_approval: 'Awaiting approval', provisional: 'Provisional',
  cancelled: 'Cancelled', rejected: 'Rejected', expired: 'Expired',
};
const START_HOUR = 6;
const END_HOUR = 24;
const time = (iso: string) => formatLondon(iso, { timeStyle: 'short' });

/** Admin: all bookings across resources in day, week or month view (FR09). */
export default function AdminCalendar() {
  const { can } = useAuth();
  const { data: resources } = useApi<Resource[]>('/admin/resources');
  const { data: organisations } = useApi<Organisation[]>('/admin/organisations');
  const { data: maintenanceTypes } = useApi<MaintenanceType[]>('/admin/maintenance-types');
  const [view, setView] = useState<CalendarView>(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 'day' : 'week'));
  const [date, setDate] = useState(londonToday());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [organisationId, setOrganisationId] = useState('');
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [maintenanceStatus, setMaintenanceStatus] = useState('planned,in_progress');
  const [maintenanceType, setMaintenanceType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Booking | null>(null);
  const [creating, setCreating] = useState<{ resourceId: string; day: string; hour: number } | null>(null);

  const range = useMemo(() => calendarRange(view, date), [view, date]);
  const colour = useMemo(() => new Map((resources ?? []).map((r, i) => [r.id, PALETTE[i % PALETTE.length]])), [resources]);
  const shown = (resources ?? []).filter((r) => !hidden.has(r.id));

  async function load() {
    const params = new URLSearchParams({ from: range.from, to: range.to, limit: '2000' });
    if (status) params.set('status', status);
    else if (!showInactive) params.set('active_only', '1');
    if (organisationId) params.set('organisation_id', organisationId);
    if (q.trim()) params.set('q', q.trim());
    if (hidden.size && resources) params.set('resource_ids', shown.map((r) => r.id).join(',') || 'none');
    try {
      setError(null);
      const mParams = new URLSearchParams({ from: range.from, to: range.to });
      if (maintenanceStatus !== 'hide' && maintenanceStatus) mParams.set('status', maintenanceStatus);
      if (maintenanceType) mParams.set('type_id', maintenanceType);
      const [b, c, m] = await Promise.all([
        api.get<Booking[]>(`/admin/bookings?${params}`),
        api.get<Closure[]>('/admin/closures'),
        maintenanceStatus === 'hide' ? Promise.resolve([]) : api.get<Maintenance[]>(`/admin/maintenance?${mParams}`),
      ]);
      setBookings(b);
      // Closures owned by maintenance are drawn as maintenance instead.
      setClosures(c.filter((x) => !x.maintenance_id && x.starts_at < range.to && x.ends_at > range.from));
      setMaintenance(m);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the calendar');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, status, organisationId, showInactive, hidden, resources, maintenanceStatus, maintenanceType]);

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  };

  const title =
    view === 'day'
      ? formatLondon(`${date}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : view === 'week'
        ? `Week of ${formatLondon(`${range.days[0]}T12:00:00Z`, { day: 'numeric', month: 'long', year: 'numeric' })}`
        : formatLondon(`${date.slice(0, 7)}-15T12:00:00Z`, { month: 'long', year: 'numeric' });

  const visible = (bookings ?? []).filter((b) => !hidden.has(b.resource_id));

  return (
    <div>
      <h1 className="text-3xl">Calendar</h1>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View" className="flex overflow-hidden rounded-xl border">
          {(['day', 'week', 'month'] as CalendarView[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={`px-3 py-2 text-sm font-bold capitalize ${view === v ? 'bg-scout-purple text-white' : 'bg-white'}`}>{v}</button>
          ))}
        </div>
        <button type="button" className="btn-secondary" aria-label="Previous" onClick={() => setDate(shiftDate(view, date, -1))}>‹</button>
        <button type="button" className="btn-secondary" onClick={() => setDate(londonToday())}>Today</button>
        <button type="button" className="btn-secondary" aria-label="Next" onClick={() => setDate(shiftDate(view, date, 1))}>›</button>
        <input type="date" aria-label="Go to date" className="input w-auto" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <h2 className="text-lg font-black" aria-live="polite">{title}</h2>
      </div>

      <details className="card mt-4" open={typeof window !== 'undefined' && window.innerWidth >= 640}>
        <summary className="cursor-pointer font-bold">Filters</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="cal-status">Status</label>
            <select id="cal-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Active bookings</option>
              {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="cal-org">Organisation</label>
            <select id="cal-org" className="input" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
              <option value="">All</option>
              {organisations?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void load(); }}>
            <label className="label" htmlFor="cal-q">Customer</label>
            <input id="cal-q" className="input" placeholder="Name, email or reference" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => void load()} />
          </form>
          <div>
            <label className="label" htmlFor="cal-mstatus">Maintenance</label>
            <select id="cal-mstatus" className="input" value={maintenanceStatus} onChange={(e) => setMaintenanceStatus(e.target.value)}>
              <option value="planned,in_progress">Planned or in progress</option>
              <option value="">All, including completed and cancelled</option>
              <option value="hide">Hide maintenance</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="cal-mtype">Maintenance type</label>
            <select id="cal-mtype" className="input" value={maintenanceType} disabled={maintenanceStatus === 'hide'} onChange={(e) => setMaintenanceType(e.target.value)}>
              <option value="">All</option>
              {maintenanceTypes?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" checked={showInactive} disabled={!!status} onChange={(e) => setShowInactive(e.target.checked)} />
            Include cancelled and expired
          </label>
        </div>
        <fieldset className="mt-3">
          <legend className="label">Resources</legend>
          <div className="flex flex-wrap gap-2">
            {resources?.map((r) => (
              <label key={r.id} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-sm">
                <input type="checkbox" checked={!hidden.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: colour.get(r.id) }} aria-hidden />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-3 text-xs text-gray-500">
          Solid border: confirmed. Dashed: awaiting approval. Dotted: provisional. Faded and struck through: cancelled or expired. ↻ marks a recurring booking. Grey hatching: closed. Orange stripes: maintenance.
        </p>
      </details>

      {error && <div className="mt-4"><ErrorState message={error} /></div>}
      {bookings === null && !error && <Spinner />}

      {bookings && view === 'day' && (
        <DayGrid
          day={date}
          resources={shown}
          bookings={visible}
          closures={closures}
          maintenance={maintenance}
          colour={colour}
          onSelect={setSelected}
          onSlot={can('bookings.create') ? (resourceId, hour) => setCreating({ resourceId, day: date, hour }) : undefined}
        />
      )}
      {bookings && view !== 'day' && (
        <DaysGrid
          view={view}
          days={range.days}
          month={date.slice(0, 7)}
          bookings={visible}
          closures={closures.filter((c) => !hidden.has(c.resource_id))}
          maintenance={maintenance.filter((m) => !hidden.has(m.resource_id))}
          colour={colour}
          resourceName={(id) => resources?.find((r) => r.id === id)?.name ?? ''}
          onSelect={setSelected}
          onDay={(d) => { setDate(d); setView('day'); }}
        />
      )}

      {selected && <BookingPanel booking={selected} onClose={() => setSelected(null)} onChanged={async () => { setSelected(null); await load(); }} />}

      {creating && resources && (
        <div className="mt-6">
          <BookForCustomer
            resources={resources.filter((r) => r.is_active)}
            initial={{
              resourceId: creating.resourceId,
              window: {
                startDate: creating.day,
                startTime: `${String(creating.hour).padStart(2, '0')}:00`,
                endDate: creating.day,
                endTime: `${String(Math.min(creating.hour + 1, 23)).padStart(2, '0')}:${creating.hour >= 23 ? '59' : '00'}`,
              },
            }}
            onClose={() => setCreating(null)}
            onCreated={async () => { setCreating(null); await load(); }}
          />
        </div>
      )}
    </div>
  );
}

function Chip({ b, colour, onSelect, showResource }: { b: Booking; colour: string; onSelect: (b: Booking) => void; showResource?: string }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(b)}
      className={`block w-full truncate rounded-md border-2 bg-white px-1.5 py-0.5 text-left text-xs ${STATUS_STYLE[b.status] ?? ''}`}
      style={{ borderColor: colour, borderLeftWidth: 6 }}
      title={`${b.resource_name}, ${time(b.starts_at)}–${time(b.ends_at)}, ${STATUS_LABEL[b.status] ?? b.status}, ${b.organisation_name ?? b.customer_name}`}
    >
      <span className="font-bold">{time(b.starts_at)}</span> {b.series_id && <span aria-label="recurring">↻ </span>}
      {showResource && <span className="text-gray-600">{showResource} · </span>}
      {b.organisation_name ?? b.customer_name}
      <span className="sr-only">, {STATUS_LABEL[b.status] ?? b.status}</span>
    </button>
  );
}

function DayGrid({
  day, resources, bookings, closures, maintenance, colour, onSelect, onSlot,
}: {
  day: string;
  resources: Resource[];
  bookings: Booking[];
  closures: Closure[];
  maintenance: Maintenance[];
  colour: Map<string, string>;
  onSelect: (b: Booking) => void;
  onSlot?: (resourceId: string, hour: number) => void;
}) {
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
  const height = hours.length * 48;
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border bg-white">
      <div className="grid" style={{ gridTemplateColumns: `3.5rem repeat(${resources.length}, minmax(9rem, 1fr))`, minWidth: `${3.5 + resources.length * 9}rem` }}>
        <div className="sticky left-0 z-10 border-b bg-white" />
        {resources.map((r) => (
          <div key={r.id} className="border-b border-l px-2 py-2 text-sm font-bold" style={{ color: colour.get(r.id) }}>{r.name}</div>
        ))}
        <div className="sticky left-0 z-10 bg-white" style={{ height }}>
          {hours.map((h) => <div key={h} className="h-12 border-t pr-1 text-right text-xs text-gray-500">{String(h).padStart(2, '0')}:00</div>)}
        </div>
        {resources.map((r) => (
          <div key={r.id} className="relative border-l" style={{ height }}>
            {hours.map((h) => (
              <button
                key={h}
                type="button"
                disabled={!onSlot}
                aria-label={onSlot ? `Book ${r.name} at ${String(h).padStart(2, '0')}:00` : undefined}
                className="block h-12 w-full border-t hover:bg-scout-purple/5 disabled:cursor-default disabled:hover:bg-transparent"
                onClick={() => onSlot?.(r.id, h)}
              />
            ))}
            {closures.filter((c) => c.resource_id === r.id && onDay(c, day)).map((c) => {
              const p = dayPosition(c, day, START_HOUR, END_HOUR);
              return (
                <div key={c.id} className="pointer-events-none absolute inset-x-0 bg-[repeating-linear-gradient(45deg,#e5e7eb_0,#e5e7eb_6px,transparent_6px,transparent_12px)]"
                  style={{ top: `${p.top * 100}%`, height: `${p.height * 100}%` }} title={`Closed${c.reason ? `: ${c.reason}` : ''}`} />
              );
            })}
            {maintenance.filter((m) => m.resource_id === r.id && onDay(m, day)).map((m) => {
              const p = dayPosition(m, day, START_HOUR, END_HOUR);
              return (
                <Link
                  key={m.id}
                  to={`/admin/maintenance?open=${m.id}`}
                  className={`absolute inset-x-0 overflow-hidden rounded-md p-1 text-xs ${MAINTENANCE_STYLE} ${m.status === 'cancelled' || m.status === 'completed' ? 'opacity-50' : ''}`}
                  style={{ top: `${p.top * 100}%`, height: `${p.height * 100}%` }}
                  title={`Maintenance: ${m.title} (${m.maintenance_type_label})`}
                >
                  <span className="font-bold">Maintenance</span>
                  <span className="block truncate">{m.title}</span>
                </Link>
              );
            })}
            {bookings.filter((b) => b.resource_id === r.id && onDay(b, day)).map((b) => {
              const p = dayPosition(b, day, START_HOUR, END_HOUR);
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect(b)}
                  className={`absolute inset-x-1 overflow-hidden rounded-md border-2 bg-white p-1 text-left text-xs shadow-sm ${STATUS_STYLE[b.status] ?? ''}`}
                  style={{ top: `${p.top * 100}%`, height: `${p.height * 100}%`, borderColor: colour.get(r.id), borderLeftWidth: 6 }}
                >
                  <span className="font-bold">{p.continuesBefore ? '…' : time(b.starts_at)}–{p.continuesAfter ? '…' : time(b.ends_at)}</span>
                  {b.series_id && <span aria-label="recurring"> ↻</span>}
                  <span className="block truncate">{b.organisation_name ?? b.customer_name}</span>
                  <span className="block truncate text-gray-500">{STATUS_LABEL[b.status] ?? b.status}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DaysGrid({
  view, days, month, bookings, closures, maintenance, colour, resourceName, onSelect, onDay: openDay,
}: {
  view: CalendarView;
  days: string[];
  month: string;
  bookings: Booking[];
  closures: Closure[];
  maintenance: Maintenance[];
  colour: Map<string, string>;
  resourceName: (id: string) => string;
  onSelect: (b: Booking) => void;
  onDay: (day: string) => void;
}) {
  const today = londonToday();
  const limit = view === 'month' ? 4 : 50;
  return (
    <div className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-gray-200 sm:grid-cols-7">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
        <div key={d} className="hidden bg-scout-off-white px-2 py-1 text-xs font-bold text-gray-600 sm:block">{d}</div>
      ))}
      {days.map((d) => {
        const items = bookings.filter((b) => onDay(b, d)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        const closed = closures.filter((c) => onDay(c, d));
        const works = maintenance.filter((m) => onDay(m, d));
        const outside = view === 'month' && d.slice(0, 7) !== month;
        if (outside && items.length === 0) return <div key={d} className="hidden bg-gray-50 sm:block" />;
        return (
          <div key={d} className={`min-h-24 space-y-1 bg-white p-1.5 ${outside ? 'opacity-60' : ''}`}>
            <button type="button" onClick={() => openDay(d)} className={`text-xs font-bold ${d === today ? 'rounded bg-scout-purple px-1 text-white' : 'text-gray-700'}`}>
              <span className="sm:hidden">{formatLondon(`${d}T12:00:00Z`, { weekday: 'short' })} </span>
              {formatLondon(`${d}T12:00:00Z`, { day: 'numeric', month: view === 'month' ? undefined : 'short' })}
            </button>
            {closed.length > 0 && (
              <p className="rounded bg-[repeating-linear-gradient(45deg,#e5e7eb_0,#e5e7eb_6px,transparent_6px,transparent_12px)] px-1 text-xs text-gray-600">
                Closed: {[...new Set(closed.map((c) => resourceName(c.resource_id)))].join(', ')}
              </p>
            )}
            {works.map((m) => (
              <Link
                key={m.id}
                to={`/admin/maintenance?open=${m.id}`}
                className={`block truncate rounded-md px-1.5 py-0.5 text-xs ${MAINTENANCE_STYLE} ${m.status === 'cancelled' || m.status === 'completed' ? 'opacity-50' : ''}`}
                title={`Maintenance: ${m.title}, ${m.resource_name}`}
              >
                <span className="font-bold">Maintenance</span> {m.resource_name} · {m.title}
              </Link>
            ))}
            {items.slice(0, limit).map((b) => (
              <Chip key={b.id} b={b} colour={colour.get(b.resource_id) ?? '#999'} onSelect={onSelect} showResource={b.resource_name} />
            ))}
            {items.length > limit && (
              <button type="button" className="text-xs font-bold text-scout-purple" onClick={() => openDay(d)}>+{items.length - limit} more</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BookingPanel({ booking: b, onClose, onChanged }: { booking: Booking; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setWorking(true);
    setError(null);
    try {
      await api.post(`/admin/bookings/${b.id}`, { decision });
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setWorking(false);
    }
  }

  return (
    <aside className="card fixed inset-x-4 bottom-4 z-40 max-h-[70vh] overflow-y-auto shadow-xl sm:inset-x-auto sm:right-6 sm:w-96" aria-labelledby="cal-panel-heading" role="dialog">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="cal-panel-heading" className="text-xl">{b.resource_name}</h2>
          <p className="text-sm text-gray-600">{formatLondon(b.starts_at)} to {time(b.ends_at)}</p>
        </div>
        <button type="button" aria-label="Close" className="text-2xl leading-none" onClick={onClose}>×</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusBadge status={b.status} />
        {b.series_id && <span className="badge bg-scout-purple/10 text-scout-purple">↻ recurring</span>}
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <div><dt className="inline text-gray-500">Reference </dt><dd className="inline font-bold">{b.reference}</dd></div>
        <div>
          <dt className="inline text-gray-500">Customer </dt>
          <dd className="inline"><Link className="font-bold text-scout-purple underline" to={`/admin/users?q=${encodeURIComponent(b.customer_email)}`}>{b.customer_name}</Link></dd>
        </div>
        {b.organisation_id && (
          <div>
            <dt className="inline text-gray-500">Organisation </dt>
            <dd className="inline"><Link className="font-bold text-scout-purple underline" to={`/organisations/${b.organisation_id}`}>{b.organisation_name}</Link></dd>
          </div>
        )}
        <div><dt className="inline text-gray-500">Total </dt><dd className="inline font-bold">{formatGBP(b.total_amount_pence)}</dd></div>
        {b.status === 'provisional' && b.expires_at && <div><dt className="inline text-gray-500">Held until </dt><dd className="inline">{formatLondon(b.expires_at)}</dd></div>}
      </dl>
      {error && <div className="mt-2"><ErrorState message={error} /></div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className="btn-primary" to={`/bookings/${b.id}`}>Open booking</Link>
        {b.series_id && <Link className="btn-secondary" to={`/series/${b.series_id}`}>View series</Link>}
        {(b.status === 'pending_approval' || b.status === 'provisional') && can('bookings.approve') && (
          <button type="button" className="btn-teal" disabled={working} onClick={() => decide('approve')}>{b.status === 'provisional' ? 'Confirm' : 'Approve'}</button>
        )}
        {b.status === 'pending_approval' && can('bookings.approve') && (
          <button type="button" className="btn-danger" disabled={working} onClick={() => decide('reject')}>Reject</button>
        )}
      </div>
    </aside>
  );
}
