import type { Env } from './http';
import { NOW_SQL, holdsResourceSql, resourceNamesSql } from './availability-sql';
import { FINANCE_STATUSES, londonDayOf, usageDays, type FinanceStatus, type Period } from '@shared/finance';

/**
 * Financial reporting (Release 3 / FR10). Every figure comes from the price
 * snapshot stored on the booking, in integer pence. With the default "usage"
 * basis a booking's value counts on the UK days it uses, split by time and
 * reconciling exactly to its total, so a booking that crosses the edge of the
 * period counts only for the part inside it. The "booked" basis counts the
 * whole value on the day the booking was made.
 */

export type Basis = 'usage' | 'booked';

export interface FinanceFilters {
  period: Period;
  basis: Basis;
  resourceId?: string | null;
  categoryId?: string | null;
  organisationId?: string | null;
}

export interface FinanceRow {
  id: string;
  reference: string;
  status: FinanceStatus;
  resource_id: string;
  /** Every resource the booking holds, e.g. "Kitchen, Main Hall". */
  resource_name: string;
  /** Each resource's share of the booking's value (from what it charged), for the breakdown by resource. */
  lines: { resource_id: string; resource_name: string; share: number }[];
  category_id: string | null;
  category_label: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  starts_at: string;
  ends_at: string;
  created_at: string;
  total_pence: number;
  base_pence: number;
  discount_pence: number;
  source: string | null;
  /** The part of the booking's value, list price and discount that falls in the period. */
  value_pence: number;
  base_in_period_pence: number;
  discount_in_period_pence: number;
  /** The value by UK day inside the period. */
  days: { day: string; pence: number }[];
}

export async function loadFinanceRows(env: Env, f: FinanceFilters): Promise<FinanceRow[]> {
  const where = [
    f.basis === 'usage' ? 'b.starts_at < ? AND b.ends_at > ?' : 'b.created_at >= ? AND b.created_at < ?',
  ];
  const binds: unknown[] = f.basis === 'usage' ? [f.period.endIso, f.period.startIso] : [f.period.startIso, f.period.endIso];
  if (f.resourceId) {
    where.push(holdsResourceSql('b'));
    binds.push(f.resourceId);
  }
  if (f.categoryId) {
    where.push('b.category_id = ?');
    binds.push(f.categoryId);
  }
  if (f.organisationId === 'none') where.push('b.organisation_id IS NULL');
  else if (f.organisationId) {
    where.push('b.organisation_id = ?');
    binds.push(f.organisationId);
  }
  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference,
            CASE WHEN b.status = 'provisional' AND b.expires_at <= ${NOW_SQL} THEN 'expired' ELSE b.status END AS status,
            b.resource_id, ${resourceNamesSql('b')} AS resource_name, b.category_id, c.label AS category_label,
            (SELECT json_group_array(json_object('resource_id', brf.resource_id, 'resource_name', rf.name, 'pence', brf.total_amount_pence))
             FROM booking_resources brf JOIN resources rf ON rf.id = brf.resource_id WHERE brf.booking_id = b.id) AS lines_json,
            b.organisation_id, o.name AS organisation_name, b.starts_at, b.ends_at, b.created_at,
            b.total_amount_pence AS total_pence, COALESCE(b.base_amount_pence, b.total_amount_pence) AS base_pence,
            COALESCE(b.discount_pence, 0) AS discount_pence, json_extract(b.price_breakdown, '$.source') AS source
     FROM bookings b
     LEFT JOIN pricing_categories c ON c.id = b.category_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.starts_at`,
  )
    .bind(...binds)
    .all<Omit<FinanceRow, 'value_pence' | 'base_in_period_pence' | 'discount_in_period_pence' | 'days' | 'lines'> & { lines_json: string | null }>();

  const inPeriod = (day: string) => day >= f.period.from && day <= f.period.to;
  return rows.results
    .filter((r) => (FINANCE_STATUSES as readonly string[]).includes(r.status))
    .map(({ lines_json, ...booking }) => {
      const lines = shares(booking, lines_json);
      if (!f.resourceId) return { ...booking, lines };
      // Filtered to one resource: count only that resource's part of the booking.
      const share = lines.find((l) => l.resource_id === f.resourceId)?.share ?? 1;
      const part = (pence: number) => Math.round(pence * share);
      return {
        ...booking,
        resource_id: f.resourceId,
        resource_name: lines.find((l) => l.resource_id === f.resourceId)?.resource_name ?? booking.resource_name,
        total_pence: part(booking.total_pence),
        base_pence: part(booking.base_pence),
        discount_pence: part(booking.discount_pence),
        lines: lines.filter((l) => l.resource_id === f.resourceId).map((l) => ({ ...l, share: 1 })),
      };
    })
    .map((r) => {
      if (f.basis === 'booked') {
        return { ...r, value_pence: r.total_pence, base_in_period_pence: r.base_pence, discount_in_period_pence: r.discount_pence, days: [{ day: londonDayOf(r.created_at), pence: r.total_pence }] };
      }
      const days = usageDays(r.starts_at, r.ends_at, r.total_pence).filter((d) => inPeriod(d.day));
      const base = usageDays(r.starts_at, r.ends_at, r.base_pence).filter((d) => inPeriod(d.day)).reduce((s, d) => s + d.pence, 0);
      const value = days.reduce((s, d) => s + d.pence, 0);
      return { ...r, value_pence: value, base_in_period_pence: base, discount_in_period_pence: base - value, days };
    })
    // Defensive: the query already limits rows to ones touching the period.
    .filter((r) => r.days.length > 0);
}

/** Each resource's share of a booking's value, in proportion to what it charged (equal shares when all are free). */
function shares(booking: { resource_id: string; resource_name: string }, json: string | null): FinanceRow['lines'] {
  const raw = (json ? (JSON.parse(json) as { resource_id: string; resource_name: string; pence: number | null }[]) : []).filter((l) => l.resource_id);
  if (!raw.length) return [{ resource_id: booking.resource_id, resource_name: booking.resource_name, share: 1 }];
  const total = raw.reduce((n, l) => n + (l.pence ?? 0), 0);
  return raw.map((l) => ({ resource_id: l.resource_id, resource_name: l.resource_name, share: total > 0 ? (l.pence ?? 0) / total : 1 / raw.length }));
}

interface Bucket { value_pence: number; count: number; average_pence: number }

const emptyTotals = () => Object.fromEntries(FINANCE_STATUSES.map((s) => [s, { value_pence: 0, count: 0, average_pence: 0 }])) as Record<FinanceStatus, Bucket>;

export interface BreakdownRow {
  key: string;
  label: string;
  totals: Record<FinanceStatus, { value_pence: number; count: number }>;
}

export function summarise(rows: FinanceRow[], period: Period) {
  const totals = emptyTotals();
  for (const r of rows) {
    totals[r.status].value_pence += r.value_pence;
    totals[r.status].count += 1;
  }
  for (const s of FINANCE_STATUSES) totals[s].average_pence = totals[s].count ? Math.round(totals[s].value_pence / totals[s].count) : 0;

  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const breakdown = (key: (r: FinanceRow) => string, label: (r: FinanceRow) => string, from: FinanceRow[] = rows): BreakdownRow[] => {
    const map = new Map<string, BreakdownRow>();
    for (const r of from) {
      const k = key(r);
      if (!map.has(k)) map.set(k, { key: k, label: label(r), totals: Object.fromEntries(FINANCE_STATUSES.map((s) => [s, { value_pence: 0, count: 0 }])) as BreakdownRow['totals'] });
      const t = map.get(k)!.totals[r.status];
      t.value_pence += r.value_pence;
      t.count += 1;
    }
    return [...map.values()].sort((a, b) => b.totals.confirmed.value_pence - a.totals.confirmed.value_pence || a.label.localeCompare(b.label));
  };

  // Chart buckets: days for periods up to about two months, otherwise months.
  const days = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
  const byMonth = days > 62;
  const series = new Map<string, Record<'confirmed' | 'provisional' | 'pending_approval', number>>();
  const keys: string[] = [];
  for (let d = period.from; d <= period.to; d = nextDay(d)) {
    const k = byMonth ? d.slice(0, 7) : d;
    if (!series.has(k)) {
      series.set(k, { confirmed: 0, provisional: 0, pending_approval: 0 });
      keys.push(k);
    }
  }
  for (const r of rows) {
    if (r.status !== 'confirmed' && r.status !== 'provisional' && r.status !== 'pending_approval') continue;
    for (const d of r.days) {
      const bucket = series.get(byMonth ? d.day.slice(0, 7) : d.day);
      if (bucket) bucket[r.status] += d.pence;
    }
  }

  return {
    totals,
    discounts: {
      // Confirmed bookings only, like the headline total.
      total_discount_pence: confirmed.reduce((s, r) => s + r.discount_in_period_pence, 0),
      list_price_pence: confirmed.reduce((s, r) => s + r.base_in_period_pence, 0),
      discounted_count: confirmed.filter((r) => r.discount_pence > 0 && r.total_pence > 0).length,
      free_count: confirmed.filter((r) => r.total_pence === 0).length,
    },
    // A booking of several resources counts once for each, with its value split between them.
    by_resource: breakdown(
      (r) => r.resource_id,
      (r) => r.resource_name,
      rows.flatMap((r) => r.lines.map((l) => ({ ...r, resource_id: l.resource_id, resource_name: l.resource_name, value_pence: Math.round(r.value_pence * l.share) }))),
    ),
    by_category: breakdown((r) => r.category_id ?? 'none', (r) => r.category_label ?? 'No price group'),
    by_organisation: breakdown((r) => r.organisation_id ?? 'none', (r) => r.organisation_name ?? 'Personal bookings'),
    series: { unit: byMonth ? 'month' : 'day', points: keys.map((k) => ({ key: k, ...series.get(k)! })) },
  };
}

function nextDay(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
