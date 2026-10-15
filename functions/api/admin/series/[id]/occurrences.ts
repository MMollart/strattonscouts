import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { can, requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { activeBookingSql } from '../../../../_lib/availability-sql';
import { amendStatements, planAmendments, type AmendTarget } from '../../../../_lib/amend';
import { guardedBatch } from '../../../../_lib/txn';
import { bookingTimeParams, sendEmail } from '../../../../_lib/email';
import { seriesDateText } from '../../../../_lib/recurring';
import { seriesAmendSchema } from '@shared/validation';
import { addDays, formatLondon, fromLondon, toLondon } from '@shared/londonTime';
import { formatGBP } from '@shared/pricing';

/**
 * Admin: change the time (and optionally the resource) of one occurrence or of
 * an occurrence and every later one (FR05 §6.5). Each date keeps its day and
 * takes the new UK times; every changed occurrence is revalidated and
 * repriced, and the change is all-or-nothing.
 */
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, seriesAmendSchema);
  if (input instanceof Response) return input;
  if (input.start_time === input.end_time) return error('The end time must differ from the start time', 400);
  if (input.override && !can(user, 'availability.manage')) {
    return error('Only authorised administrators can override booking restrictions', 403);
  }
  const id = String(params.id);

  const anchor = await env.DB.prepare('SELECT starts_at FROM bookings WHERE id = ? AND series_id = ?')
    .bind(input.booking_id, id)
    .first<{ starts_at: string }>();
  if (!anchor) return error('That booking is not part of this series', 404);

  const targets = await env.DB.prepare(
    `SELECT id, user_id, organisation_id, resource_id, starts_at, ends_at, total_amount_pence FROM bookings
     WHERE series_id = ? AND ${activeBookingSql('')} AND ${input.scope === 'one' ? 'id = ?' : 'starts_at >= ?'}
     ORDER BY starts_at`,
  )
    .bind(id, input.scope === 'one' ? input.booking_id : anchor.starts_at)
    .all<AmendTarget>();
  if (!targets.results.length) return error('There are no active occurrences to change', 400);

  const overnight = input.end_time <= input.start_time;
  const changes = targets.results.map((t) => {
    const date = toLondon(t.starts_at).date;
    return {
      target: t,
      resourceId: input.resource_id ?? t.resource_id,
      startsAt: fromLondon(date, input.start_time),
      endsAt: fromLondon(overnight ? addDays(date, 1) : date, input.end_time),
    };
  });
  const plan = await planAmendments(env, changes, { override: input.override ?? null });
  if (!plan.ok) return error('Some occurrences cannot be changed', 409, { code: 'unavailable', problems: plan.problems });

  const done = await guardedBatch(env, plan.planned.flatMap((c) => amendStatements(env, c, user.id, { series_id: id, scope: input.scope })));
  if (!done) return error('Another booking was made for one of these times just now. Please try again.', 409, { code: 'conflict' });

  const series = await env.DB.prepare(
    `SELECT s.reference, r.name AS resource_name, u.email, u.full_name FROM recurrence_series s
     JOIN users u ON u.id = s.user_id JOIN resources r ON r.id = ? WHERE s.id = ?`,
  )
    .bind(plan.planned[0].resourceId, id)
    .first<{ reference: string; resource_name: string; email: string; full_name: string }>();
  if (series) {
    const first = plan.planned[0];
    const last = plan.planned[plan.planned.length - 1];
    const day = { dateStyle: 'medium' } as const;
    await sendEmail(env, {
      to: series.email,
      dedupeKey: `${id}:booking_amended:${crypto.randomUUID()}`,
      template: 'booking_amended',
      params: {
        customer_name: series.full_name,
        booking_reference: series.reference,
        resource_name: series.resource_name,
        ...bookingTimeParams(first.startsAt, first.endsAt),
        booking_date: seriesDateText(plan.planned.length, formatLondon(first.startsAt, day), formatLondon(last.startsAt, day)),
        booking_cost: formatGBP(plan.planned.reduce((s, c) => s + c.price.total_pence, 0)),
        booking_status: 'amended',
      },
    });
  }
  return json({ ok: true, changed: plan.planned.length });
};
