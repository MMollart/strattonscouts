import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBookingAtomic } from '../functions/_lib/booking';
import { transitionBooking } from '../functions/_lib/lifecycle';
import { loadBusyPeriods } from '../functions/_lib/availability-sql';
import type { Env } from '../functions/_lib/http';
import { addUser, createTestEnv } from './helpers/d1';

/**
 * Integration tests for the booking engine against a real D1 database
 * (Miniflare/workerd SQLite) with the project's migrations and seed applied.
 * Seed resources: res_whole (approval; every other resource is part of it), res_small, res_main,
 * res_kitchen (auto-confirm, hourly), res_field, res_camping (approval, nightly).
 */

const win = { startsAt: '2026-06-01T10:00:00.000Z', endsAt: '2026-06-01T12:00:00.000Z' };

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1');
  await addUser(db, 'u2', 'cat_public');
  await addUser(db, 'admin');
});

afterEach(async () => {
  await dispose();
});

function book(userId: string, resourceId: string, window = win) {
  return createBookingAtomic({ env, userId, resourceId, ...window, actorId: userId });
}

async function activeBookingCount(): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM bookings WHERE status IN ('pending_approval', 'confirmed')")
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function addClosure(resourceId: string, startsAt: string, endsAt: string) {
  await db
    .prepare('INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
    .bind(crypto.randomUUID(), resourceId, startsAt, endsAt, new Date().toISOString())
    .run();
}

describe('booking allocation', () => {
  it('auto-confirms when approval is not required, with the category price (AC13, AC05)', async () => {
    const r = await book('u1', 'res_main');
    expect(r).toMatchObject({ ok: true, status: 'confirmed', totalPence: 2000 });
    const publicPrice = await book('u2', 'res_small');
    expect(publicPrice).toMatchObject({ ok: true, totalPence: 3000 });
  });

  it('enters Pending Approval and reserves the resource (AC14, AC15)', async () => {
    const r = await book('u1', 'res_whole');
    expect(r).toMatchObject({ ok: true, status: 'pending_approval' });
    expect(await book('u2', 'res_main')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('applies the Whole Venue rules in both directions (AC09)', async () => {
    expect((await book('u1', 'res_main')).ok).toBe(true);
    expect(await book('u2', 'res_whole')).toMatchObject({ ok: false, code: 'conflict' });
    expect(await book('u2', 'res_whole', { startsAt: '2026-06-02T10:00:00.000Z', endsAt: '2026-06-02T12:00:00.000Z' })).toMatchObject({ ok: true });
    expect(await book('u1', 'res_camping', { startsAt: '2026-06-02T11:00:00.000Z', endsAt: '2026-06-03T10:00:00.000Z' })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('allows sibling resources at the same time, but not a resource and its parent (AC10)', async () => {
    expect((await book('u1', 'res_main')).ok).toBe(true);
    expect((await book('u2', 'res_small')).ok).toBe(true);
    expect((await book('u1', 'res_kitchen')).ok).toBe(true);

    await db.prepare("UPDATE resources SET parent_id = 'res_field' WHERE id = 'res_camping'").run();
    expect((await book('u1', 'res_field')).ok).toBe(true);
    expect(await book('u2', 'res_camping')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('treats touching bookings as non-overlapping', async () => {
    expect((await book('u1', 'res_main')).ok).toBe(true);
    expect((await book('u2', 'res_main', { startsAt: win.endsAt, endsAt: '2026-06-01T14:00:00.000Z' })).ok).toBe(true);
  });

  it('normalises time zone offsets before comparing', async () => {
    expect((await book('u1', 'res_main')).ok).toBe(true);
    // 11:00 BST = 10:00 UTC, overlapping the first booking.
    const r = await book('u2', 'res_main', { startsAt: '2026-06-01T11:00:00+01:00', endsAt: '2026-06-01T12:30:00+01:00' });
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('never lets concurrent conflicting submissions both succeed (AC11, AC12)', async () => {
    const resources = ['res_main', 'res_whole', 'res_main', 'res_whole'];
    const attempts = Array.from({ length: 24 }, (_, i) =>
      book(i % 2 === 0 ? 'u1' : 'u2', resources[i % resources.length]),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await activeBookingCount()).toBe(1);
    // No orphaned allocation or event rows from the losing attempts.
    const alloc = await db.prepare('SELECT COUNT(*) AS c FROM booking_resources').first<{ c: number }>();
    const events = await db.prepare('SELECT COUNT(*) AS c FROM booking_events').first<{ c: number }>();
    expect(alloc?.c).toBe(1);
    expect(events?.c).toBe(1);
  });

  it('rejects a request that was overtaken between its checks and its write', async () => {
    // Request B starts first, then is held just before it writes; request A
    // completes in that gap. B must not also succeed.
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const heldDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            reached();
            await gate;
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const heldEnv = { ...env, DB: heldDb } as Env;

    const requestB = createBookingAtomic({ env: heldEnv, userId: 'u2', resourceId: 'res_whole', ...win, actorId: 'u2' });
    await atWrite;
    await new Promise((r) => setTimeout(r, 5));
    const requestA = await book('u1', 'res_main');
    release();
    const resultB = await requestB;

    expect(requestA.ok).toBe(true);
    expect(resultB).toMatchObject({ ok: false, code: 'conflict' });
    expect(await activeBookingCount()).toBe(1);
  });

  it('allows concurrent non-conflicting submissions to all succeed', async () => {
    const results = await Promise.all(['res_main', 'res_small', 'res_kitchen'].map((r) => book('u1', r)));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('prices nightly bookings across multiple nights (AC18)', async () => {
    const r = await book('u1', 'res_camping', { startsAt: '2026-06-05T17:00:00.000Z', endsAt: '2026-06-07T10:00:00.000Z' });
    expect(r).toMatchObject({ ok: true, totalPence: 4000 });
  });

  it('keeps the agreed price when pricing changes later (AC19)', async () => {
    const r = await book('u1', 'res_main');
    await db.prepare("UPDATE pricing_rates SET amount_pence = 9999 WHERE resource_id = 'res_main'").run();
    const row = await db.prepare('SELECT total_amount_pence FROM bookings WHERE id = ?').bind(r.ok && r.bookingId).first<{ total_amount_pence: number }>();
    expect(row?.total_amount_pence).toBe(2000);
  });
});

describe('closures', () => {
  it('blocks the closed resource', async () => {
    await addClosure('res_main', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
    expect(await book('u1', 'res_main')).toMatchObject({ ok: false, code: 'closure' });
  });

  it('closing the Whole Venue closes every resource, and closing a hall closes the Whole Venue', async () => {
    await addClosure('res_whole', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
    expect(await book('u1', 'res_small')).toMatchObject({ ok: false, code: 'closure' });

    await addClosure('res_kitchen', '2026-06-03T00:00:00.000Z', '2026-06-04T00:00:00.000Z');
    const day3 = { startsAt: '2026-06-03T10:00:00.000Z', endsAt: '2026-06-03T12:00:00.000Z' };
    expect(await book('u1', 'res_whole', day3)).toMatchObject({ ok: false, code: 'closure' });
    // Closing one individual resource does not close another.
    expect((await book('u1', 'res_small', day3)).ok).toBe(true);
  });
});

describe('approval, rejection and cancellation', () => {
  async function pending(resourceId = 'res_field', window = win): Promise<string> {
    const r = await book('u1', resourceId, window);
    if (!r.ok || r.status !== 'pending_approval') throw new Error('expected a pending booking');
    return r.bookingId;
  }

  it('approves a pending booking (AC16)', async () => {
    const id = await pending();
    expect(await transitionBooking(env, { bookingId: id, to: 'confirmed', actorId: 'admin', actorIsAdmin: true })).toEqual({ ok: true });
    const row = await db.prepare('SELECT status, approved_by FROM bookings WHERE id = ?').bind(id).first();
    expect(row).toEqual({ status: 'confirmed', approved_by: 'admin' });
  });

  it('revalidates on approval against closures added since the request', async () => {
    const id = await pending();
    await addClosure('res_field', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
    expect(await transitionBooking(env, { bookingId: id, to: 'confirmed', actorId: 'admin', actorIsAdmin: true })).toMatchObject({ ok: false, code: 'closure' });
  });

  it('revalidates on approval against parents set since the request', async () => {
    const id = await pending('res_field');
    expect((await book('u2', 'res_main')).ok).toBe(true);
    await db.prepare("UPDATE resources SET parent_id = 'res_field' WHERE id = 'res_main'").run();
    expect(await transitionBooking(env, { bookingId: id, to: 'confirmed', actorId: 'admin', actorIsAdmin: true })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('rejection and cancellation release availability (AC17)', async () => {
    const id = await pending('res_whole');
    expect((await transitionBooking(env, { bookingId: id, to: 'rejected', actorId: 'admin', actorIsAdmin: true })).ok).toBe(true);
    const main = await book('u2', 'res_main');
    expect(main.ok).toBe(true);
    expect((await transitionBooking(env, { bookingId: main.ok ? main.bookingId : '', to: 'cancelled', actorId: 'u2', actorIsAdmin: false })).ok).toBe(true);
    expect((await book('u1', 'res_whole')).ok).toBe(true);
    const cancelled = await db.prepare('SELECT status, cancelled_by FROM bookings WHERE id = ?').bind(main.ok && main.bookingId).first();
    expect(cancelled).toEqual({ status: 'cancelled', cancelled_by: 'u2' });
  });

  it('applies only one of two simultaneous status changes', async () => {
    const id = await pending();
    const [approve, cancel] = await Promise.all([
      transitionBooking(env, { bookingId: id, to: 'confirmed', actorId: 'admin', actorIsAdmin: true }),
      transitionBooking(env, { bookingId: id, to: 'cancelled', actorId: 'u1', actorIsAdmin: false }),
    ]);
    const outcomes = [approve.ok, cancel.ok].filter(Boolean);
    // Approve then cancel is a legitimate sequence; what must never happen is
    // a lost update, so the events must match the final state.
    const events = await db.prepare('SELECT event_type FROM booking_events WHERE booking_id = ? ORDER BY created_at').bind(id).all<{ event_type: string }>();
    const final = await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(id).first<{ status: string }>();
    expect(events.results).toHaveLength(1 + outcomes.length);
    expect(['confirmed', 'cancelled']).toContain(final?.status);
  });

  it('refuses to approve a booking that is no longer pending', async () => {
    const id = await pending();
    await transitionBooking(env, { bookingId: id, to: 'rejected', actorId: 'admin', actorIsAdmin: true });
    expect(await transitionBooking(env, { bookingId: id, to: 'confirmed', actorId: 'admin', actorIsAdmin: true })).toMatchObject({ ok: false, code: 'invalid_transition' });
  });
});

describe('public availability data', () => {
  it('returns busy periods without any customer details (AC06)', async () => {
    await book('u1', 'res_whole');
    await addClosure('res_main', '2026-06-01T13:00:00.000Z', '2026-06-01T15:00:00.000Z');
    const busy = await loadBusyPeriods(env, 'res_main', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
    expect(busy).toEqual([
      { starts_at: win.startsAt, ends_at: win.endsAt, kind: 'booked', resource_name: 'Whole Venue', relation: 'parent' },
      { starts_at: '2026-06-01T13:00:00.000Z', ends_at: '2026-06-01T15:00:00.000Z', kind: 'closed', resource_name: 'Main Hall', relation: 'self' },
    ]);
  });
});
