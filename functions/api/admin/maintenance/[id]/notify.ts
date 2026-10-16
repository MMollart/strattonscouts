import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { recordAudit } from '../../../../_lib/audit';
import { bookingTimeParams, sendEmail } from '../../../../_lib/email';
import { findAffectedBookings } from '../../../../_lib/maintenance';
import { formatLondon } from '@shared/londonTime';
import { maintenanceNotifySchema } from '@shared/validation';

/**
 * Admin: tell the customers of affected bookings about maintenance (FR22
 * §4.9), using the "Maintenance notice" email template. Bookings are not
 * changed or cancelled. Each customer is emailed once per version of the
 * maintenance record, so a retry never sends twice but a later change can be
 * announced again. Defaults to every booking the maintenance overlaps.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, maintenanceNotifySchema);
  if (input instanceof Response) return input;
  const id = String(params.id);
  const m = await env.DB.prepare('SELECT id, reference, resource_id, title, starts_at, ends_at, status, updated_at FROM maintenance_records WHERE id = ?')
    .bind(id)
    .first<{ id: string; reference: string; resource_id: string; title: string; starts_at: string; ends_at: string; status: string; updated_at: string }>();
  if (!m) return error('Maintenance record not found', 404);
  if (m.status === 'cancelled') return error('This maintenance has been cancelled', 409);

  const recorded = await env.DB.prepare('SELECT booking_id FROM maintenance_affected_bookings WHERE maintenance_id = ?').bind(id).all<{ booking_id: string }>();
  const overlapping = await findAffectedBookings(env, m.resource_id, m.starts_at, m.ends_at);
  const eligible = new Set([...overlapping.map((b) => b.id), ...recorded.results.map((r) => r.booking_id)]);
  const chosen = input.booking_ids?.length ? input.booking_ids : [...eligible];
  if (chosen.some((b) => !eligible.has(b))) return error('Only bookings affected by this maintenance can be notified', 400);
  if (!chosen.length) return error('No bookings are affected by this maintenance', 400);

  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.starts_at, b.ends_at, b.status, u.email, u.full_name, r.name AS resource_name, o.name AS organisation_name
     FROM bookings b JOIN users u ON u.id = b.user_id JOIN resources r ON r.id = b.resource_id LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE b.id IN (${chosen.map(() => '?').join(', ')})`,
  )
    .bind(...chosen)
    .all<{ id: string; reference: string; starts_at: string; ends_at: string; status: string; email: string; full_name: string; resource_name: string; organisation_name: string | null }>();

  const sent: string[] = [];
  for (const b of rows.results) {
    const result = await sendEmail(env, {
      to: b.email,
      bookingId: b.id,
      template: 'maintenance_notice',
      dedupeKey: `${m.id}:${b.id}:maintenance_notice:${m.updated_at}`,
      params: {
        customer_name: b.full_name,
        organisation_name: b.organisation_name ?? '',
        booking_reference: b.reference,
        resource_name: b.resource_name,
        ...bookingTimeParams(b.starts_at, b.ends_at),
        booking_cost: '',
        booking_status: b.status,
        maintenance_title: m.title,
        maintenance_period: `${formatLondon(m.starts_at)} to ${formatLondon(m.ends_at)}`,
        maintenance_message: input.message,
      },
    });
    if (result.status !== 'failed') sent.push(b.reference);
  }
  const ts = now();
  await env.DB.batch(
    rows.results.map((b) =>
      env.DB.prepare('UPDATE maintenance_affected_bookings SET notified_at = ?, updated_at = ? WHERE maintenance_id = ? AND booking_id = ?').bind(ts, ts, m.id, b.id),
    ),
  );
  await recordAudit(env, {
    actor: user,
    action: 'maintenance.customers_notified',
    entityType: 'maintenance',
    entityId: m.id,
    entityLabel: m.title,
    after: { bookings: rows.results.map((b) => b.reference) },
    reason: input.message || null,
    resourceId: m.resource_id,
  });
  return json({ notified: sent.length, bookings: sent });
};
