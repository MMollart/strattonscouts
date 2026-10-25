import type { Env } from './http';
import { error, json, newId, now } from './http';
import type { AuthUser } from './auth';
import { BLOCKED_SET_SQL, activeBookingSql, canonicalIso } from './availability-sql';
import { abortIf, guardedBatch } from './txn';
import { audited } from './audit';
import { findAffectedBookings, maintenanceBlocks, maintenanceClosureStatements, shortReference } from './maintenance';
import type { MaintenanceInput } from '@shared/validation';

interface Existing {
  id: string;
  reference: string;
  maintenance_type_id: string;
  created_by: string;
  created_at: string;
}

/**
 * Create or update a maintenance record (FR22 §4.2–4.6). When it blocks
 * availability and overlaps active bookings, it is refused with the list of
 * bookings (code "conflicts") unless the administrator acknowledges them and
 * gives a reason; then it is saved, the bookings are recorded as needing
 * action, and nothing is cancelled. A booking made meanwhile that the
 * administrator has not seen aborts the save.
 */
export async function saveMaintenance(env: Env, user: AuthUser, input: MaintenanceInput, existing: Existing | null): Promise<Response> {
  const [resource, type] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT id, name FROM resources WHERE id = ?').bind(input.resource_id),
    env.DB.prepare('SELECT id, is_active FROM maintenance_types WHERE id = ?').bind(input.maintenance_type_id),
  ]);
  if (!resource.results.length) return error('Resource not found', 400);
  const t = type.results[0] as { is_active: number } | undefined;
  if (!t) return error('Unknown maintenance type', 400);
  if (!t.is_active && existing?.maintenance_type_id !== input.maintenance_type_id) return error('This maintenance type has been retired', 400);
  if (input.assigned_admin_id) {
    const admin = await env.DB.prepare('SELECT 1 FROM user_roles WHERE user_id = ?').bind(input.assigned_admin_id).first();
    if (!admin) return error('Maintenance can only be assigned to an administrator', 400);
  }

  const ts = now();
  const record = {
    id: existing?.id ?? newId('mnt'),
    reference: existing?.reference ?? shortReference('MNT'),
    resource_id: input.resource_id,
    maintenance_type_id: input.maintenance_type_id,
    title: input.title,
    description: input.description,
    starts_at: canonicalIso(input.starts_at),
    ends_at: canonicalIso(input.ends_at),
    status: input.status,
    blocks_availability: input.blocks_availability ? 1 : 0,
    assigned_admin_id: input.assigned_admin_id ?? null,
    notes: input.notes,
  };

  const affected = maintenanceBlocks(record) ? await findAffectedBookings(env, record.resource_id, record.starts_at, record.ends_at) : [];
  // Bookings already reviewed when this record was saved before need no new exception.
  const reviewed = existing
    ? new Set((await env.DB.prepare('SELECT booking_id FROM maintenance_affected_bookings WHERE maintenance_id = ?').bind(existing.id).all<{ booking_id: string }>()).results.map((r) => r.booking_id))
    : new Set<string>();
  const unreviewed = affected.filter((b) => !reviewed.has(b.id));
  const exception = input.acknowledge_conflicts ? input.exception_reason?.trim() : '';
  if (unreviewed.length && !exception) {
    return error(
      `This maintenance overlaps ${unreviewed.length} existing booking${unreviewed.length === 1 ? '' : 's'}. Review them and give a reason to save it anyway; they will not be cancelled.`,
      409,
      { code: 'conflicts', conflicts: unreviewed },
    );
  }

  const write = existing
    ? env.DB.prepare(
        `UPDATE maintenance_records SET resource_id = ?, maintenance_type_id = ?, title = ?, description = ?, starts_at = ?, ends_at = ?, status = ?,
                blocks_availability = ?, assigned_admin_id = ?, notes = ?, conflict_exception_reason = COALESCE(?, conflict_exception_reason), updated_at = ?
         WHERE id = ?`,
      ).bind(
        record.resource_id, record.maintenance_type_id, record.title, record.description, record.starts_at, record.ends_at, record.status,
        record.blocks_availability, record.assigned_admin_id, record.notes, unreviewed.length ? exception : null, ts, record.id,
      )
    : env.DB.prepare(
        `INSERT INTO maintenance_records (id, reference, resource_id, maintenance_type_id, title, description, starts_at, ends_at, status,
                                          blocks_availability, assigned_admin_id, notes, conflict_exception_reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        record.id, record.reference, record.resource_id, record.maintenance_type_id, record.title, record.description, record.starts_at, record.ends_at,
        record.status, record.blocks_availability, record.assigned_admin_id, record.notes, unreviewed.length ? exception : null, user.id, ts, ts,
      );

  const statements: D1PreparedStatement[] = [write, ...maintenanceClosureStatements(env, record, ts)];
  if (maintenanceBlocks(record)) {
    // Nothing the administrator has not reviewed may have been booked since.
    const seen = affected.map((b) => b.id);
    statements.unshift(
      abortIf(
        env,
        `EXISTS (SELECT 1 FROM bookings b JOIN booking_resources brm ON brm.booking_id = b.id
                 WHERE ${activeBookingSql('b')} AND brm.resource_id IN (${BLOCKED_SET_SQL})
                 AND b.starts_at < ? AND b.ends_at > ?${seen.length ? ` AND b.id NOT IN (${seen.map(() => '?').join(', ')})` : ''})`,
        record.resource_id, record.resource_id, record.resource_id, record.ends_at, record.starts_at, ...seen,
      ),
    );
  }
  for (const b of unreviewed) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO maintenance_affected_bookings (maintenance_id, booking_id, status, created_at, updated_at) VALUES (?, ?, 'needs_action', ?, ?)
         ON CONFLICT(maintenance_id, booking_id) DO NOTHING`,
      ).bind(record.id, b.id, ts, ts),
    );
  }

  let aborted = false;
  await audited(
    env,
    {
      actor: user,
      action: existing ? (input.status === 'cancelled' || input.status === 'completed' ? `maintenance.${input.status}` : 'maintenance.updated') : 'maintenance.created',
      table: 'maintenance_records',
      id: record.id,
      reason: unreviewed.length ? `Saved over ${unreviewed.map((b) => b.reference).join(', ')}: ${exception}` : null,
    },
    async () => {
      const done = await guardedBatch(env, statements);
      aborted = !done;
      return !!done;
    },
  );
  if (aborted) return error('A booking was made for this time just now. Review the conflicts again.', 409, { code: 'conflicts_changed' });
  return json({ id: record.id, reference: record.reference, affected_bookings: affected, newly_affected: unreviewed }, existing ? 200 : 201);
}
