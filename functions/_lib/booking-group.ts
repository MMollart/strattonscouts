import type { Env } from './http';
import { newId } from './http';
import { abortIf, guardedBatch } from './txn';
import { bookingInsertStatements, prepareBooking, type BookingDraft, type CreateBookingFailure, type CreateBookingParams } from './booking';
import { ANCESTORS_SQL, CONFLICTING_BOOKING_SQL } from './availability-sql';

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

  // A resource and one it is part of (a hall and the Whole Venue) cannot be
  // booked together: the parent already includes the child, so it would be
  // charged twice.
  const ancestors = await env.DB.batch<{ resource_id: string }>(ids.map((id) => env.DB.prepare(ANCESTORS_SQL).bind(id)));
  for (const [i, child] of ids.entries()) {
    const parent = ancestors[i].results.find((a) => ids.includes(a.resource_id))?.resource_id;
    if (parent) {
      const names = await resourceNames(env, [child, parent]);
      return {
        ok: false,
        code: 'conflict',
        message: `${names[child]} is part of ${names[parent]}, so they cannot be booked together. ${names[parent]} already includes it.`,
      };
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
