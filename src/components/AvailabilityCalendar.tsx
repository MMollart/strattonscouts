import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { ErrorState } from './ui';
import {
  addDays,
  formatLondon,
  fromLondon,
  londonToday,
  toLondon,
  weekdayMondayFirst,
} from '@shared/londonTime';
import { evaluateRestrictions, type AvailabilityRule } from '@shared/availability-rules';
import { blockedMessage, type BlockedBy } from '@shared/hierarchy';

type View = 'month' | 'week' | 'day';
type SlotState = 'free' | 'booked' | 'closed' | 'restricted' | 'past';

interface BusyPeriod {
  starts_at: string;
  ends_at: string;
  kind: 'booked' | 'closed';
  /** The resource booked or closed: this one, a parent that includes it or a child that is part of it. */
  resource_name: string;
  relation: BlockedBy['relation'];
}

/** Why a slot is booked or closed when a parent or child causes it, e.g. "Whole Venue is booked at this time, and it includes this resource." */
function busyReason(start: string, end: string, busy: BusyPeriod[], kind: BusyPeriod['kind']): string | null {
  const period = busy.find((b) => b.kind === kind && b.relation !== 'self' && overlaps(start, end, b.starts_at, b.ends_at));
  return period ? blockedMessage(kind, { name: period.resource_name, relation: period.relation }) : null;
}

interface Restrictions {
  minNoticeMinutes: number | null;
  maxAdvanceDays: number | null;
  rules: AvailabilityRule[];
}

const NO_RESTRICTIONS: Restrictions = { minNoticeMinutes: null, maxAdvanceDays: null, rules: [] };

interface Selection {
  start: string;
  end: string;
}

// Hours shown in the week and day grids (UK time). Bookings outside these
// hours still show in month view and are always checked when booking.
const FIRST_HOUR = 7;
const LAST_HOUR = 23;
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Why a window breaks the booking rules (opening hours, recurring restrictions, notice), or null. */
function ruleBlock(start: string, end: string, restrictions: Restrictions): string | null {
  const violations = evaluateRestrictions({ startsAt: start, endsAt: end, now: Date.now(), ...restrictions });
  return violations[0]?.message ?? null;
}

function slotState(start: string, end: string, busy: BusyPeriod[], nowIso: string, restrictions: Restrictions): SlotState {
  if (end <= nowIso) return 'past';
  if (busy.some((b) => b.kind === 'closed' && overlaps(start, end, b.starts_at, b.ends_at))) return 'closed';
  if (busy.some((b) => overlaps(start, end, b.starts_at, b.ends_at))) return 'booked';
  if (ruleBlock(start, end, restrictions)) return 'restricted';
  return 'free';
}

function visibleRange(view: View, anchor: string): { first: string; days: number } {
  if (view === 'day') return { first: anchor, days: 1 };
  if (view === 'week') return { first: addDays(anchor, -weekdayMondayFirst(anchor)), days: 7 };
  const monthStart = `${anchor.slice(0, 7)}-01`;
  return { first: addDays(monthStart, -weekdayMondayFirst(monthStart)), days: 42 };
}

function shiftAnchor(view: View, anchor: string, direction: 1 | -1): string {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  const [y, m] = anchor.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + direction, 1));
  return d.toISOString().slice(0, 10);
}

function heading(view: View, anchor: string, first: string): string {
  if (view === 'month') return formatLondon(fromLondon(anchor, '12:00'), { month: 'long', year: 'numeric' });
  if (view === 'day') return formatLondon(fromLondon(anchor, '12:00'), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const last = addDays(first, 6);
  return `${formatLondon(fromLondon(first, '12:00'), { day: 'numeric', month: 'short' })} – ${formatLondon(fromLondon(last, '12:00'), { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

const SLOT_STYLE: Record<SlotState, string> = {
  free: 'bg-white hover:bg-scout-teal/15 text-gray-700',
  booked: 'bg-scout-purple/80 text-white cursor-not-allowed',
  closed: 'bg-gray-400 text-white cursor-not-allowed bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,0.25)_4px,rgba(255,255,255,0.25)_8px)]',
  restricted: 'bg-gray-200 text-gray-500 cursor-not-allowed',
  past: 'bg-gray-100 text-gray-400 cursor-not-allowed',
};

const STATE_LABEL: Record<SlotState, string> = {
  free: 'available',
  booked: 'unavailable, already booked',
  closed: 'unavailable, closed',
  restricted: 'not bookable',
  past: 'in the past',
};

export default function AvailabilityCalendar({
  resourceId,
  resourceSlug,
  resourceName,
}: {
  resourceId: string;
  resourceSlug: string;
  resourceName: string;
}) {
  const [view, setView] = useState<View>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches ? 'day' : 'week',
  );
  const [anchor, setAnchor] = useState(londonToday());
  const [busy, setBusy] = useState<BusyPeriod[]>([]);
  const [restrictions, setRestrictions] = useState<Restrictions>(NO_RESTRICTIONS);
  const [active, setActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  const { first, days } = visibleRange(view, anchor);
  const dates = useMemo(() => Array.from({ length: days }, (_, i) => addDays(first, i)), [first, days]);
  const nowIso = new Date().toISOString();

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    const from = fromLondon(first, '00:00');
    const to = fromLondon(addDays(first, days), '00:00');
    api
      .get<{ active: boolean; busy: BusyPeriod[]; restrictions?: Restrictions }>(
        `/calendar?resource_id=${encodeURIComponent(resourceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      )
      .then((res) => {
        if (!current) return;
        setBusy(res.busy);
        setRestrictions(res.restrictions ?? NO_RESTRICTIONS);
        setActive(res.active);
      })
      .catch((e) => current && setError(e instanceof ApiError ? e.message : 'Could not load availability'))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [resourceId, first, days]);

  useEffect(() => setSelection(null), [resourceId]);

  function choose(start: string, end: string) {
    if (selection && start >= selection.start && slotState(selection.start, end, busy, nowIso, restrictions) === 'free') {
      setSelection({ start: selection.start, end }); // extend the current selection
    } else {
      setSelection({ start, end });
    }
  }

  function isSelected(start: string, end: string): boolean {
    return !!selection && start >= selection.start && end <= selection.end;
  }

  function hourSlot(date: string, hour: number) {
    const start = fromLondon(date, hh(hour));
    const end = fromLondon(hour + 1 === 24 ? addDays(date, 1) : date, hour + 1 === 24 ? '00:00' : hh(hour + 1));
    const state = slotState(start, end, busy, nowIso, restrictions);
    const selected = isSelected(start, end);
    const reason =
      state === 'restricted' ? ruleBlock(start, end, restrictions) : state === 'booked' || state === 'closed' ? busyReason(start, end, busy, state) : null;
    const label = `${formatLondon(start, { weekday: 'long', day: 'numeric', month: 'long' })}, ${hh(hour)} to ${hh(hour + 1)}, ${STATE_LABEL[state]}${reason ? `: ${reason}` : ''}`;
    return (
      <button
        key={`${date}-${hour}`}
        type="button"
        className={`h-9 w-full border-b border-r border-gray-200 text-xs transition-colors ${
          selected ? 'bg-scout-teal text-white ring-2 ring-inset ring-scout-teal' : SLOT_STYLE[state]
        }`}
        disabled={state !== 'free'}
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={() => choose(start, end)}
      >
        {state === 'closed' ? 'Closed' : ''}
      </button>
    );
  }

  function dayState(date: string): { state: SlotState | 'partial'; label: string } {
    const start = fromLondon(date, hh(FIRST_HOUR));
    const end = fromLondon(date, hh(LAST_HOUR));
    if (end <= nowIso) return { state: 'past', label: 'in the past' };
    const relevant = busy.filter((b) => overlaps(start, end, b.starts_at, b.ends_at));
    if (relevant.some((b) => b.kind === 'closed' && b.starts_at <= start && b.ends_at >= end)) {
      return { state: 'closed', label: 'closed' };
    }
    const states = HOURS.map((h) => slotState(fromLondon(date, hh(h)), fromLondon(date, hh(h + 1)), busy, nowIso, restrictions));
    if (!states.includes('free')) {
      return states.includes('booked') ? { state: 'booked', label: 'fully booked' } : { state: 'restricted', label: 'not bookable' };
    }
    return relevant.length || states.includes('booked') ? { state: 'partial', label: 'partly booked' } : { state: 'free', label: 'available' };
  }

  const title = heading(view, anchor, first);
  const thisMonth = anchor.slice(0, 7);

  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary px-3 py-1.5" onClick={() => setAnchor(shiftAnchor(view, anchor, -1))} aria-label={`Previous ${view}`}>
            ‹
          </button>
          <button type="button" className="btn-secondary px-3 py-1.5" onClick={() => setAnchor(londonToday())}>
            Today
          </button>
          <button type="button" className="btn-secondary px-3 py-1.5" onClick={() => setAnchor(shiftAnchor(view, anchor, 1))} aria-label={`Next ${view}`}>
            ›
          </button>
          <h2 className="ml-2 text-lg" aria-live="polite">{title}</h2>
        </div>
        <div className="inline-flex rounded-full border-2 border-scout-purple p-0.5" role="group" aria-label="Calendar view">
          {(['month', 'week', 'day'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={`rounded-full px-3 py-1 text-sm font-bold capitalize ${view === v ? 'bg-scout-purple text-white' : 'text-scout-purple'}`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="p-4"><ErrorState message={error} /></div>}
      {!active && <p className="p-4 text-gray-700">{resourceName} is not currently available to book.</p>}

      {!error && active && (
        <div className={`relative ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          {view === 'month' ? (
            <div className="grid grid-cols-7 text-sm">
              {WEEKDAYS.map((d) => (
                <div key={d} className="border-b border-gray-200 p-2 text-center text-xs font-bold text-gray-500">{d}</div>
              ))}
              {dates.map((date) => {
                const { state, label } = dayState(date);
                const outside = date.slice(0, 7) !== thisMonth;
                const tone =
                  state === 'free' ? 'bg-scout-green' : state === 'partial' ? 'bg-scout-yellow' : state === 'booked' ? 'bg-scout-purple' : state === 'closed' ? 'bg-gray-400' : state === 'restricted' ? 'bg-gray-200' : 'bg-transparent';
                return (
                  <button
                    key={date}
                    type="button"
                    className={`flex h-16 flex-col items-start gap-1 border-b border-r border-gray-200 p-2 text-left hover:bg-scout-off-white sm:h-20 ${outside ? 'text-gray-400' : ''} ${state === 'past' ? 'text-gray-300' : ''}`}
                    aria-label={`${formatLondon(fromLondon(date, '12:00'), { weekday: 'long', day: 'numeric', month: 'long' })}, ${label}. Show this day.`}
                    onClick={() => {
                      setAnchor(date);
                      setView('day');
                    }}
                  >
                    <span className={`font-bold ${date === londonToday() ? 'rounded-full bg-scout-purple px-1.5 text-white' : ''}`}>
                      {Number(date.slice(8))}
                    </span>
                    {state !== 'past' && <span className={`h-2 w-full rounded-full ${tone}`} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div
                className="grid min-w-full"
                style={{ gridTemplateColumns: `3.5rem repeat(${dates.length}, minmax(${view === 'week' ? '3rem' : '8rem'}, 1fr))` }}
              >
                <div className="border-b border-r border-gray-200" />
                {dates.map((date) => (
                  <div key={date} className="border-b border-r border-gray-200 p-2 text-center text-xs font-bold">
                    {formatLondon(fromLondon(date, '12:00'), { weekday: 'short' })}
                    <br />
                    {formatLondon(fromLondon(date, '12:00'), { day: 'numeric', month: 'short' })}
                  </div>
                ))}
                {HOURS.map((hour) => (
                  <div key={hour} className="contents">
                    <div className="border-b border-r border-gray-200 pr-1 pt-0.5 text-right text-xs text-gray-500">{hh(hour)}</div>
                    {dates.map((date) => hourSlot(date, hour))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 border-t border-gray-200 p-4 text-xs text-gray-600">
        {view === 'month' ? (
          <>
            <Legend tone="bg-scout-green" label="Available" />
            <Legend tone="bg-scout-yellow" label="Partly booked" />
            <Legend tone="bg-scout-purple" label="Fully booked" />
            <Legend tone="bg-gray-400" label="Closed" />
            <Legend tone="bg-gray-200" label="Not bookable" />
            <span>Select a day to choose times.</span>
          </>
        ) : (
          <>
            <Legend tone="bg-white border border-gray-300" label="Available" />
            <Legend tone="bg-scout-purple/80" label="Booked" />
            <Legend tone="bg-gray-400" label="Closed" />
            <Legend tone="bg-gray-200" label="Not bookable (opening hours or booking rules)" />
            <Legend tone="bg-scout-teal" label="Your selection" />
            <span>Times are UK time, {hh(FIRST_HOUR)}–{hh(LAST_HOUR)}. Select a start, then an end.</span>
          </>
        )}
      </div>

      {selection && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-scout-teal/10 p-4" aria-live="polite">
          <p className="text-sm">
            <span className="font-bold">{resourceName}</span>: {formatLondon(selection.start)} to{' '}
            {toLondon(selection.start).date === toLondon(selection.end).date
              ? formatLondon(selection.end, { timeStyle: 'short' })
              : formatLondon(selection.end)}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary px-4 py-2" onClick={() => setSelection(null)}>Clear</button>
            <Link
              to={`/book/${resourceSlug}?start=${encodeURIComponent(selection.start)}&end=${encodeURIComponent(selection.end)}`}
              className="btn-primary px-4 py-2"
            >
              Book this time
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded-sm ${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}
