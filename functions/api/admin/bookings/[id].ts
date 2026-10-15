import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { transitionBooking } from '../../../_lib/lifecycle';

// Admin: approve or reject a pending booking. Body: { decision: 'approve'|'reject' }
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.approve');
  if (user instanceof Response) return user;
  const id = String(params.id);

  let body: { decision?: string };
  try {
    body = (await request.json()) as { decision?: string };
  } catch {
    return error('Invalid JSON body');
  }
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return error('decision must be "approve" or "reject"', 400);
  }

  const result = await transitionBooking(env, {
    bookingId: id,
    to: body.decision === 'approve' ? 'confirmed' : 'rejected',
    actorId: user.id,
    actorIsAdmin: true,
  });
  if (!result.ok) {
    const message =
      result.code === 'conflict'
        ? 'This booking now clashes with another active booking, so it cannot be approved'
        : result.code === 'closure'
          ? 'This booking overlaps a closure, so it cannot be approved'
          : result.code === 'not_found'
            ? 'Booking not found'
            : 'This booking has already been updated';
    return error(message, result.code === 'not_found' ? 404 : 409, { code: result.code });
  }
  return json({ ok: true });
};
