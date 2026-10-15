import type { Env } from '../../../_lib/http';
import { error, json, newId, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { abortIf, guardedBatch } from '../../../_lib/txn';
import { amendStatements, planAmendments } from '../../../_lib/amend';
import { loadAmendable } from '../../../_lib/amendments';
import { bookingTimeParams, sendEmail } from '../../../_lib/email';
import { amendmentDecisionSchema } from '@shared/validation';
import { formatGBP, type PriceBreakdown } from '@shared/pricing';

interface Amendment {
  id: string;
  booking_id: string;
  status: string;
  to_resource_id: string;
  to_starts_at: string;
  to_ends_at: string;
  price_breakdown: string;
}

/**
 * Admin: approve or reject a change request (FR12 §11.4). Approval revalidates
 * the new time and updates the booking, its allocation and price in one
 * guarded batch; the original booking is untouched unless that succeeds.
 * The customer pays the price shown when they made the request.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.approve');
  if (user instanceof Response) return user;
  const input = await parseBody(request, amendmentDecisionSchema);
  if (input instanceof Response) return input;
  const id = String(params.id);

  const amendment = await env.DB.prepare('SELECT * FROM booking_amendments WHERE id = ?').bind(id).first<Amendment>();
  if (!amendment) return error('Change request not found', 404);
  if (amendment.status !== 'pending') return error('This change request has already been decided', 409, { code: 'decided' });
  const booking = await loadAmendable(env, amendment.booking_id);
  if (!booking) return error('Booking not found', 404);
  const ts = now();
  const decide = (status: 'approved' | 'rejected') =>
    env.DB.prepare(
      `UPDATE booking_amendments SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    ).bind(status, user.id, ts, input.note ?? null, ts, id);

  const customer = await env.DB.prepare(
    'SELECT u.email, u.full_name, r.name AS resource_name FROM users u JOIN resources r ON r.id = ? WHERE u.id = ?',
  )
    .bind(input.decision === 'approve' ? amendment.to_resource_id : booking.resource_id, booking.user_id)
    .first<{ email: string; full_name: string; resource_name: string }>();

  if (input.decision === 'reject') {
    const [res] = await env.DB.batch([
      decide('rejected'),
      env.DB.prepare(
        `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
         SELECT ?, ?, 'amendment_rejected', ?, ?, ? WHERE changes() = 1`,
      ).bind(newId('bev'), booking.id, user.id, JSON.stringify({ amendment_id: id, note: input.note ?? null }), ts),
    ]);
    if (res.meta.changes !== 1) return error('This change request has already been decided', 409, { code: 'decided' });
    if (customer) {
      await sendEmail(env, {
        to: customer.email,
        bookingId: booking.id,
        dedupeKey: `${id}:booking_amendment_rejected`,
        template: 'booking_amendment_rejected',
        params: {
          customer_name: customer.full_name,
          booking_reference: booking.reference,
          resource_name: customer.resource_name,
          ...bookingTimeParams(booking.starts_at, booking.ends_at),
          decision_note: input.note ?? '',
        },
      });
    }
    return json({ ok: true, status: 'rejected' });
  }

  if (!booking.active) return error('The booking is no longer active, so the change cannot be applied', 409, { code: 'inactive' });
  const plan = await planAmendments(env, [{ target: booking, resourceId: amendment.to_resource_id, startsAt: amendment.to_starts_at, endsAt: amendment.to_ends_at }]);
  if (!plan.ok) {
    return error(`The requested time is no longer available: ${plan.problems.map((p) => p.message).join(' ')}`, 409, { code: plan.problems[0].reason, problems: plan.problems });
  }
  const agreed: PriceBreakdown = JSON.parse(amendment.price_breakdown);
  const change = { ...plan.planned[0], price: agreed };
  const done = await guardedBatch(env, [
    ...amendStatements(env, change, user.id, { amendment_id: id }),
    decide('approved'),
    abortIf(env, 'changes() = 0'),
  ]);
  if (!done) {
    const latest = await env.DB.prepare('SELECT status FROM booking_amendments WHERE id = ?').bind(id).first<{ status: string }>();
    if (latest?.status !== 'pending') return error('This change request has already been decided', 409, { code: 'decided' });
    return error('The requested time was booked by someone else just now', 409, { code: 'conflict' });
  }

  if (customer) {
    await sendEmail(env, {
      to: customer.email,
      bookingId: booking.id,
      dedupeKey: `${id}:booking_amended`,
      template: 'booking_amended',
      params: {
        customer_name: customer.full_name,
        booking_reference: booking.reference,
        resource_name: customer.resource_name,
        ...bookingTimeParams(change.startsAt, change.endsAt),
        booking_cost: formatGBP(agreed.total_pence),
        booking_status: 'amended',
      },
    });
  }
  return json({ ok: true, status: 'approved' });
};
