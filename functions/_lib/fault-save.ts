import type { Env } from './http';
import { error, json, newId, now } from './http';
import type { AuthUser } from './auth';
import { audited } from './audit';
import { faultClosureStatements, findAffectedBookings, OPEN_ENDED, shortReference } from './maintenance';
import type { FaultInput } from '@shared/validation';

export const FAULT_SELECT = `
  SELECT f.*, r.name AS resource_name, u.full_name AS reported_by_name
  FROM resource_faults f JOIN resources r ON r.id = f.resource_id LEFT JOIN users u ON u.id = f.reported_by`;

/**
 * Report or update a fault (FR22 §4.7). A fault marked as preventing bookings
 * closes its resource (and, through the hierarchy, what it is part of and
 * what is part of it) from when it was reported until it is resolved or
 * closed. Existing bookings are kept and returned so they can be followed up.
 */
export async function saveFault(
  env: Env,
  user: AuthUser,
  input: FaultInput,
  existing: { id: string; reference: string; reported_at: string; reported_by: string; resolved_at: string | null } | null,
): Promise<Response> {
  if (!(await env.DB.prepare('SELECT 1 FROM resources WHERE id = ?').bind(input.resource_id).first())) return error('Resource not found', 400);
  const ts = now();
  const resolved = input.status === 'resolved' || input.status === 'closed';
  const f = {
    id: existing?.id ?? newId('flt'),
    reference: existing?.reference ?? shortReference('FLT'),
    resource_id: input.resource_id,
    reported_at: existing?.reported_at ?? ts,
    status: input.status,
    blocks_bookings: input.blocks_bookings ? 1 : 0,
  };
  const resolvedAt = resolved ? (existing?.resolved_at ?? ts) : null;
  const write = existing
    ? env.DB.prepare(
        `UPDATE resource_faults SET resource_id = ?, description = ?, severity = ?, status = ?, blocks_bookings = ?, resolution_notes = ?, resolved_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(f.resource_id, input.description, input.severity, f.status, f.blocks_bookings, input.resolution_notes, resolvedAt, ts, f.id)
    : env.DB.prepare(
        `INSERT INTO resource_faults (id, reference, resource_id, description, severity, status, blocks_bookings, reported_at, reported_by, resolution_notes, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(f.id, f.reference, f.resource_id, input.description, input.severity, f.status, f.blocks_bookings, f.reported_at, user.id, input.resolution_notes, resolvedAt, ts, ts);

  await audited(
    env,
    { actor: user, action: existing ? (resolved ? `fault.${input.status}` : 'fault.updated') : 'fault.reported', table: 'resource_faults', id: f.id },
    async () => !!(await env.DB.batch([write, ...faultClosureStatements(env, f, ts)])),
  );
  const affected = f.blocks_bookings && !resolved ? await findAffectedBookings(env, f.resource_id, ts, OPEN_ENDED) : [];
  return json({ id: f.id, reference: f.reference, affected_bookings: affected }, existing ? 200 : 201);
}
