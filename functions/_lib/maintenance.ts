import type { Env } from './http';
import { BLOCKED_SET_SQL, activeBookingSql, resourceNamesSql } from './availability-sql';

/**
 * Maintenance and faults (Release 3 / FR22). Blocking is done with a
 * resource_closures row owned by the record, so the one availability engine
 * (closures + the resource hierarchy) enforces it for new bookings,
 * approvals, amendments and the public calendar alike.
 */

/** An open fault blocks bookings from when it was reported until it is resolved. */
export const OPEN_ENDED = '9999-12-31T00:00:00.000Z';

const ACTIVE_MAINTENANCE = ['planned', 'in_progress'];
const OPEN_FAULT = ['open', 'in_progress'];

export function maintenanceBlocks(m: { status: string; blocks_availability: number | boolean }): boolean {
  return !!m.blocks_availability && ACTIVE_MAINTENANCE.includes(m.status);
}

export function faultBlocks(f: { status: string; blocks_bookings: number | boolean }): boolean {
  return !!f.blocks_bookings && OPEN_FAULT.includes(f.status);
}

/** Statements that make the record's closure match the record (remove it, then re-add it if it blocks). */
export function maintenanceClosureStatements(
  env: Env,
  m: { id: string; resource_id: string; starts_at: string; ends_at: string; title: string; status: string; blocks_availability: number | boolean },
  ts: string,
): D1PreparedStatement[] {
  const out = [env.DB.prepare('DELETE FROM resource_closures WHERE maintenance_id = ?').bind(m.id)];
  if (maintenanceBlocks(m)) {
    out.push(
      env.DB.prepare(
        'INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at, maintenance_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(`cls_${m.id}`, m.resource_id, m.starts_at, m.ends_at, `Maintenance: ${m.title}`, ts, m.id),
    );
  }
  return out;
}

export function faultClosureStatements(
  env: Env,
  f: { id: string; resource_id: string; reported_at: string; reference: string; status: string; blocks_bookings: number | boolean },
  ts: string,
): D1PreparedStatement[] {
  const out = [env.DB.prepare('DELETE FROM resource_closures WHERE fault_id = ?').bind(f.id)];
  if (faultBlocks(f)) {
    out.push(
      env.DB.prepare(
        'INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at, fault_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(`cls_${f.id}`, f.resource_id, f.reported_at, OPEN_ENDED, `Out of use: fault ${f.reference}`, ts, f.id),
    );
  }
  return out;
}

export interface AffectedBooking {
  id: string;
  reference: string;
  status: string;
  starts_at: string;
  ends_at: string;
  resource_id: string;
  resource_name: string;
  customer_name: string;
  organisation_name: string | null;
}

/**
 * Active bookings that a closure of `resourceId` over [startsAt, endsAt)
 * would overlap: on the resource itself, anything it is part of, and
 * anything part of it (the same hierarchy rule as every closure).
 */
export async function findAffectedBookings(env: Env, resourceId: string, startsAt: string, endsAt: string): Promise<AffectedBooking[]> {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.resource_id, ${resourceNamesSql('b')} AS resource_name,
            u.full_name AS customer_name, o.name AS organisation_name
     FROM bookings b JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE ${activeBookingSql('b')}
       AND EXISTS (SELECT 1 FROM booking_resources bra WHERE bra.booking_id = b.id AND bra.resource_id IN (${BLOCKED_SET_SQL}))
       AND b.starts_at < ? AND b.ends_at > ?
     ORDER BY b.starts_at`,
  )
    .bind(resourceId, resourceId, resourceId, endsAt, startsAt)
    .all<AffectedBooking>();
  return rows.results;
}

/** Short human reference, e.g. MNT-7F3K9Q. */
export function shortReference(prefix: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}-${s}`;
}

/** Maintenance columns with resource, type and assignee names, and how many affected bookings still need action. */
export const MAINTENANCE_SELECT = `
  SELECT m.*, r.name AS resource_name, t.label AS maintenance_type_label, a.full_name AS assigned_admin_name,
         (SELECT COUNT(*) FROM maintenance_affected_bookings x WHERE x.maintenance_id = m.id AND x.status = 'needs_action') AS bookings_needing_action
  FROM maintenance_records m
  JOIN resources r ON r.id = m.resource_id
  JOIN maintenance_types t ON t.id = m.maintenance_type_id
  LEFT JOIN users a ON a.id = m.assigned_admin_id`;
