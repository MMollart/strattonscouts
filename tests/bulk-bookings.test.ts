import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as bulkApi from '../functions/api/admin/bookings/bulk';
import { expireProvisionalBookings } from '../functions/_lib/provisional';
import { renderEmail, sampleItems, templateDefinition } from '../src/shared/email-templates';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1');
  await addUser(db, 'u2');
  await addAdmin(db, 'booker', 'booking_admin');
  await addAdmin(db, 'viewer', 'viewer');
});

afterEach(async () => {
  await dispose();
});

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** A booking for one customer; the Event Field needs approval, the Main Hall does not. */
async function book(user: string, n: number, extra: Record<string, unknown> = {}): Promise<string> {
  const cookie = await sessionFor(env, user);
  const res = await call(bookingsApi.onRequestPost, {
    env,
    cookie,
    body: { resource_id: 'res_field', starts_at: `${day(n)}T10:00:00.000Z`, ends_at: `${day(n)}T12:00:00.000Z`, ...extra },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function emailsTo(user: string, template: string): Promise<{ dedupe_key: string; booking_reference: string | null }[]> {
  const rows = await db
    .prepare('SELECT dedupe_key, booking_reference FROM email_events WHERE recipient = ? AND template = ? ORDER BY created_at')
    .bind(`${user}@example.com`, template)
    .all<{ dedupe_key: string; booking_reference: string | null }>();
  return rows.results;
}

const bulk = async (ids: string[], action: string, user = 'booker') =>
  call(bulkApi.onRequestPost, { env, cookie: await sessionFor(env, user), body: { ids, action } });

describe('bulk booking actions', () => {
  it('approves several bookings and sends each person one email', async () => {
    const a = [await book('u1', 10), await book('u1', 11), await book('u1', 12)];
    const b = await book('u2', 13);

    const res = await bulk([...a, b], 'approve');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(4);

    const statuses = await db.prepare(`SELECT DISTINCT status FROM bookings WHERE id IN (?, ?, ?, ?)`).bind(...a, b).all<{ status: string }>();
    expect(statuses.results).toEqual([{ status: 'confirmed' }]);

    // Three bookings: one combined email, no individual approval emails.
    expect(await emailsTo('u1', 'booking_approved')).toHaveLength(0);
    const combined = await emailsTo('u1', 'bookings_updated');
    expect(combined).toHaveLength(1);
    expect(combined[0].booking_reference?.split(', ')).toHaveLength(3);
    // One booking: the usual approval email.
    expect(await emailsTo('u2', 'booking_approved')).toHaveLength(1);
    expect(await emailsTo('u2', 'bookings_updated')).toHaveLength(0);
  });

  it('reports bookings it could not change and still does the rest', async () => {
    const ok = await book('u1', 10);
    const closed = await book('u2', 11);
    // The venue has since been closed over the second booking, so it can no longer be approved.
    await db.prepare(
      "INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at) VALUES ('cl1', 'res_whole', ?, ?, 'Works', ?)",
    ).bind(`${day(11)}T00:00:00.000Z`, `${day(12)}T00:00:00.000Z`, new Date().toISOString()).run();
    const res = await bulk([ok, closed, 'missing'], 'approve');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.results).toEqual([
      { id: ok, ok: true },
      expect.objectContaining({ id: closed, ok: false, code: 'closure' }),
      expect.objectContaining({ id: 'missing', ok: false, code: 'not_found' }),
    ]);
  });

  it('rejects and cancels in bulk with one email per person', async () => {
    const pending = [await book('u1', 10), await book('u1', 11)];
    expect((await bulk(pending, 'reject')).body.updated).toBe(2);
    expect(await emailsTo('u1', 'booking_rejected')).toHaveLength(0);
    expect(await emailsTo('u1', 'bookings_updated')).toHaveLength(1);

    const more = [await book('u1', 20), await book('u1', 21)];
    expect((await bulk(more, 'cancel')).body.updated).toBe(2);
    expect(await emailsTo('u1', 'booking_cancelled')).toHaveLength(0);
    expect(await emailsTo('u1', 'bookings_updated')).toHaveLength(2);
  });

  it('needs the right permission for each action', async () => {
    const id = await book('u1', 10);
    expect((await bulk([id], 'approve', 'viewer')).status).toBe(403);
    expect((await bulk([id], 'cancel', 'viewer')).status).toBe(403);
    expect((await bulk([id], 'approve', 'u1')).status).toBe(403);
    expect((await bulk([], 'approve')).status).toBe(400);
  });

  it('sends one email per person when several provisional holds expire together', async () => {
    for (const n of [10, 11]) {
      await book('u1', n, { resource_id: 'res_main', provisional: true });
    }
    await book('u2', 12, { resource_id: 'res_main', provisional: true });
    await db.prepare("UPDATE bookings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE status = 'provisional'").run();

    expect(await expireProvisionalBookings(env)).toBe(3);
    expect(await emailsTo('u1', 'provisional_expired')).toHaveLength(0);
    expect(await emailsTo('u1', 'bookings_updated')).toHaveLength(1);
    expect(await emailsTo('u2', 'provisional_expired')).toHaveLength(1);
  });
});

describe('the combined email', () => {
  it('repeats the detail card for each booking with its own values', () => {
    const def = templateDefinition('bookings_updated')!;
    const email = renderEmail(def, { customer_name: 'Alex', booking_count: '2', venue_name: 'Stratton' }, { items: sampleItems('bookings_updated') });
    expect(email.subject).toBe('Update on 2 of your Stratton bookings');
    expect(email.text).toContain('Booking: Main Hall\nStatus: Approved');
    expect(email.text).toContain('Booking: Kitchen\nStatus: Approved');
    expect(email.html.match(/Main Hall|Kitchen/g)).toHaveLength(2);
  });
});
