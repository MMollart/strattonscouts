import type { Env } from './http';
import type { AuthUser } from './auth';
import { can } from './auth';
import { fromLondon, addDays } from '@shared/londonTime';

/**
 * Searching the audit history (FR11 §6.4). Shared by the list, a record's own
 * History section and the CSV export, so they always agree.
 */

export interface AuditFilters {
  from?: string | null; // YYYY-MM-DD, UK date, inclusive
  to?: string | null; // YYYY-MM-DD, UK date, inclusive
  actor_id?: string | null;
  actor_type?: string | null;
  organisation_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  resource_id?: string | null;
  action?: string | null; // exact, or a prefix ending in '.' (e.g. "booking.")
  booking_id?: string | null;
  booking_reference?: string | null;
  q?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function filtersFromUrl(url: URL): AuditFilters {
  const get = (k: string) => url.searchParams.get(k)?.trim() || null;
  return {
    from: get('from'),
    to: get('to'),
    actor_id: get('actor_id'),
    actor_type: get('actor_type'),
    organisation_id: get('organisation_id'),
    entity_type: get('entity_type'),
    entity_id: get('entity_id'),
    resource_id: get('resource_id'),
    action: get('action'),
    booking_id: get('booking_id'),
    booking_reference: get('booking_reference'),
    q: get('q'),
  };
}

export const AUDIT_SELECT = `
  SELECT e.seq, e.id, e.created_at, e.actor_id, e.actor_type, au.full_name AS actor_name, e.action, e.entity_type, e.entity_id,
         COALESCE(e.entity_label, CASE WHEN e.entity_type = 'user' THEN tu.full_name END) AS entity_label,
         e.before_json, e.after_json, e.reason, e.booking_id, bk.reference AS booking_reference,
         e.organisation_id, o.name AS organisation_name, e.resource_id, e.hash IS NOT NULL AS sealed
  FROM audit_events e
  LEFT JOIN users au ON au.id = e.actor_id
  LEFT JOIN users tu ON e.entity_type = 'user' AND tu.id = e.entity_id
  LEFT JOIN bookings bk ON bk.id = e.booking_id
  LEFT JOIN organisations o ON o.id = e.organisation_id`;

function like(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function auditWhere(f: AuditFilters): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.from && DATE.test(f.from)) {
    where.push('e.created_at >= ?');
    binds.push(fromLondon(f.from, '00:00'));
  }
  if (f.to && DATE.test(f.to)) {
    where.push('e.created_at < ?');
    binds.push(fromLondon(addDays(f.to, 1), '00:00'));
  }
  const eq = (col: string, v: string | null | undefined) => {
    if (v) {
      where.push(`${col} = ?`);
      binds.push(v);
    }
  };
  eq('e.actor_id', f.actor_id);
  eq('e.actor_type', f.actor_type);
  eq('e.organisation_id', f.organisation_id);
  eq('e.entity_type', f.entity_type);
  eq('e.entity_id', f.entity_id);
  eq('e.resource_id', f.resource_id);
  eq('e.booking_id', f.booking_id);
  if (f.action) {
    if (f.action.endsWith('.')) {
      where.push("e.action LIKE ? ESCAPE '\\'");
      binds.push(`${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    } else eq('e.action', f.action);
  }
  if (f.booking_reference) {
    where.push('bk.reference = ?');
    binds.push(f.booking_reference.toUpperCase());
  }
  if (f.q) {
    where.push("(e.entity_label LIKE ? ESCAPE '\\' OR au.full_name LIKE ? ESCAPE '\\' OR e.action LIKE ? ESCAPE '\\' OR bk.reference LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')");
    const l = like(f.q);
    binds.push(l, l, l, l, l);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', binds };
}

export interface AuditRowView {
  seq: number;
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  booking_id: string | null;
  booking_reference: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  resource_id: string | null;
  sealed: boolean;
}

/**
 * Viewers have restricted access (§8): they see who did what to which
 * record and when, but not the values that changed or the reasons given.
 */
export function auditAccess(user: AuthUser): 'full' | 'restricted' | null {
  if (can(user, 'audit.view')) return 'full';
  if (can(user, 'bookings.view')) return 'restricted';
  return null;
}

export async function searchAudit(
  env: Env,
  f: AuditFilters,
  opts: { access: 'full' | 'restricted'; beforeSeq?: number | null; limit: number },
): Promise<AuditRowView[]> {
  const { sql, binds } = auditWhere(f);
  const cursor = opts.beforeSeq ? `${sql ? `${sql} AND` : 'WHERE'} e.seq < ?` : sql;
  const rows = await env.DB.prepare(`${AUDIT_SELECT} ${cursor} ORDER BY e.seq DESC LIMIT ?`)
    .bind(...binds, ...(opts.beforeSeq ? [opts.beforeSeq] : []), opts.limit)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => {
    const full = opts.access === 'full';
    const parse = (v: unknown) => (full && typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : null);
    return {
      seq: r.seq as number,
      id: r.id as string,
      created_at: r.created_at as string,
      actor_id: r.actor_id as string | null,
      actor_type: r.actor_type as string,
      actor_name: (r.actor_name as string | null) ?? null,
      action: r.action as string,
      entity_type: r.entity_type as string,
      entity_id: r.entity_id as string,
      entity_label: (r.entity_label as string | null) ?? null,
      before: parse(r.before_json),
      after: parse(r.after_json),
      reason: full ? ((r.reason as string | null) ?? null) : null,
      booking_id: (r.booking_id as string | null) ?? null,
      booking_reference: (r.booking_reference as string | null) ?? null,
      organisation_id: (r.organisation_id as string | null) ?? null,
      organisation_name: (r.organisation_name as string | null) ?? null,
      resource_id: (r.resource_id as string | null) ?? null,
      sealed: !!r.sealed,
    };
  });
}
