import type { Env } from './http';
import { newId } from './http';
import { abortIf, guardedBatch } from './txn';
import { bookingInsertStatements, prepareBooking, type BookingDraft, type CreateBookingFailure, type CreateBookingParams } from './booking';
import { BLOCKED_SET_SQL, CONFLICTING_BOOKING_SQL } from './availability-sql';

export interface GroupBooking {
  bookingId: string;
  reference: string;
  resourceId: string;
  status: BookingDraft['status'];
  totalPence: number;
  expiresAt: string | null;
}

export type CreateGroupResult =
  | { ok: true; groupId: string; startsAt: string; endsAt: string; bookings: GroupBooking[]; totalPence: number }
  | (CreateBookingFailure & { resourceId?: string });

/**
 * Book several resources for the same time in one request. Each resource is
 * validated and priced exactly as a single booking (rules, closures, approval,
 * provisional holds), then every booking is written in one guarded batch: if
 * any resource is taken meanwhile, nothing is booked.
 */
export async function createBookingGroup(params: Omit<CreateBookingParams, 'resourceId'> & { resourceIds: string[] }): Promise<CreateGroupResult> {
  const { env } = params;
  const ids = [...new Set(params.resourceIds)];

  // Resources that block each other (a hall and the Whole Venue that contains it) cannot be booked together.
  for (const [i, a] of ids.entries()) {
    for (const b of ids.slice(i + 1)) {
      const overlap = await env.DB.prepare(`SELECT 1 FROM (${BLOCKED_SET_SQL}) WHERE conflicts_with_id = ?`).bind(a, a, a, b).first();
      if (overlap) {
        const names = await resourceNames(env, [a, b]);
        return { ok: false, code: 'conflict', message: `${names[a]} and ${names[b]} cannot be booked together because one includes the other.` };
      }
    }
  }

  const groupId = newId('grp');
  const drafts: BookingDraft[] = [];
  for (const resourceId of ids) {
    const prepared = await prepareBooking({ ...params, resourceId });
    if (!prepared.ok) {
      const names = await resourceNames(env, [resourceId]);
      return { ...prepared, resourceId, message: `${names[resourceId] ?? 'A resource'}: ${prepared.message}` };
    }
    // Say which resource is taken; the guarded batch below re-checks regardless.
    const d = prepared.draft;
    if (await env.DB.prepare(CONFLICTING_BOOKING_SQL).bind(resourceId, resourceId, resourceId, d.endsAt, d.startsAt, '').first()) {
      const names = await resourceNames(env, [resourceId]);
      return { ok: false, code: 'conflict', resourceId, message: `${names[resourceId] ?? 'A resource'} is already booked at this time, so nothing was booked.` };
    }
    drafts.push({ ...d, groupId });
  }

  const statements = drafts.flatMap((d) => [
    ...bookingInsertStatements(env, d),
    abortIf(env, 'NOT EXISTS (SELECT 1 FROM bookings WHERE id = ?)', d.id),
  ]);
  const result = await guardedBatch(env, statements);
  if (!result) return { ok: false, code: 'conflict', message: 'One of the resources is no longer available for this period, so nothing was booked.' };

  return {
    ok: true,
    groupId,
    startsAt: drafts[0].startsAt,
    endsAt: drafts[0].endsAt,
    bookings: drafts.map((d) => ({ bookingId: d.id, reference: d.reference, resourceId: d.resourceId, status: d.status, totalPence: d.price.total_pence, expiresAt: d.expiresAt })),
    totalPence: drafts.reduce((sum, d) => sum + d.price.total_pence, 0),
  };
}

async function resourceNames(env: Env, ids: string[]): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(`SELECT id, name FROM resources WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all<{ id: string; name: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.id, r.name]));
}
