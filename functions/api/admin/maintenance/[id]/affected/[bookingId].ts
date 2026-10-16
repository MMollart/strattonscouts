import type { Env } from '../../../../../_lib/http';
import { error, json, now } from '../../../../../_lib/http';
import { requirePermission } from '../../../../../_lib/auth';
import { parseBody } from '../../../../../_lib/request';
import { auditStatement } from '../../../../../_lib/audit';
import { affectedBookingSchema } from '@shared/validation';

// Admin: mark a booking affected by maintenance as dealt with (or not), with a note.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, affectedBookingSchema);
  if (input instanceof Response) return input;
  const maintenanceId = String(params.id);
  const bookingId = String(params.bookingId);
  const current = await env.DB.prepare('SELECT status FROM maintenance_affected_bookings WHERE maintenance_id = ? AND booking_id = ?')
    .bind(maintenanceId, bookingId)
    .first<{ status: string }>();
  if (!current) return error('That booking is not recorded against this maintenance', 404);
  await env.DB.batch([
    env.DB.prepare('UPDATE maintenance_affected_bookings SET status = ?, resolution_note = ?, updated_at = ? WHERE maintenance_id = ? AND booking_id = ?')
      .bind(input.status, input.resolution_note ?? null, now(), maintenanceId, bookingId),
    auditStatement(env, {
      actor: user,
      action: 'maintenance.affected_booking_updated',
      entityType: 'maintenance',
      entityId: maintenanceId,
      before: { booking_id: bookingId, status: current.status },
      after: { booking_id: bookingId, status: input.status },
      reason: input.resolution_note ?? null,
      bookingId,
    }),
  ]);
  return json({ ok: true });
};
