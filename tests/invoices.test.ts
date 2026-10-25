import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as invoicesApi from '../functions/api/admin/bookings/[id]/invoices';
import * as bookingsApi from '../functions/api/bookings/index';
import { addDays, londonToday } from '@shared/londonTime';

describe('Invoices', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'booker', 'booking_admin');
  });
  afterEach(async () => {
    await dispose();
  });

  const nextWeek = () => {
    const d = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return { starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T12:00:00.000Z` };
  };
  const book = async () => (await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u1'), body: { resource_id: 'res_main', ...nextWeek() } })).body;
  const send = async (id: string, body?: unknown) =>
    call(invoicesApi.onRequestPost, { env, method: 'POST', cookie: await sessionFor(env, 'booker'), params: { id }, body });

  it('issues a numbered invoice, emails the hirer and records it', async () => {
    const booking = await book();
    const res = await send(booking.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, to: 'u1@example.com', reissued: false, invoice: { invoice_number: 'INV-000001', amount_pence: 2000, send_count: 1 } });
    expect(res.body.invoice.due_date).toBe(addDays(londonToday(), 14));

    const email = await db.prepare("SELECT recipient, subject, status FROM email_events WHERE template = 'booking_invoice'").first();
    expect(email).toEqual({ recipient: 'u1@example.com', subject: `Invoice INV-000001 for booking ${booking.reference}`, status: 'sent' });
    const audit = await db.prepare("SELECT actor_id, after_json FROM audit_events WHERE action = 'booking.invoice_sent'").first<{ actor_id: string; after_json: string }>();
    expect(audit?.actor_id).toBe('booker');
    expect(JSON.parse(audit!.after_json)).toMatchObject({ invoice_number: 'INV-000001', amount_pence: 2000 });

    const list = await call(invoicesApi.onRequestGet, { env, cookie: await sessionFor(env, 'booker'), params: { id: booking.id } });
    expect(list.body.map((i: { invoice_number: string }) => i.invoice_number)).toEqual(['INV-000001']);
  });

  it('resends the same invoice while the price is unchanged, and issues a new one when it changes', async () => {
    const a = await book();
    await send(a.id);
    const again = await send(a.id);
    expect(again.body.invoice).toMatchObject({ invoice_number: 'INV-000001', send_count: 2 });

    // Numbers run across bookings.
    await db.prepare("UPDATE bookings SET starts_at = replace(starts_at, 'T10', 'T14'), ends_at = replace(ends_at, 'T12', 'T16') WHERE id = ?").bind(a.id).run();
    const b = await book();
    expect((await send(b.id)).body.invoice.invoice_number).toBe('INV-000002');

    await db.prepare('UPDATE bookings SET total_amount_pence = 2500, base_amount_pence = 2500, discount_pence = 0 WHERE id = ?').bind(a.id).run();
    const changed = await send(a.id);
    expect(changed.body).toMatchObject({ reissued: true, invoice: { invoice_number: 'INV-000003', amount_pence: 2500 } });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM email_events WHERE template = 'booking_invoice'").first<{ c: number }>())?.c).toBe(4);
  });

  it('can bill the organisation contact', async () => {
    const booking = await book();
    const ts = new Date().toISOString();
    await db
      .prepare(`INSERT INTO organisations (id, name, organisation_type_id, pricing_category_id, contact_email, created_by, created_at, updated_at)
                VALUES ('org1', '1st Stratton', 'scout_group', 'cat_scouts', 'treasurer@example.com', 'u1', ?, ?)`)
      .bind(ts, ts)
      .run();
    expect((await send(booking.id, { recipient: 'organisation' })).status).toBe(400);
    await db.prepare("UPDATE bookings SET organisation_id = 'org1' WHERE id = ?").bind(booking.id).run();
    const res = await send(booking.id, { recipient: 'organisation' });
    expect(res.body).toMatchObject({ ok: true, to: 'treasurer@example.com' });
  });

  it('refuses unconfirmed or free bookings, disabled templates and customers', async () => {
    const booking = await book();
    expect((await call(invoicesApi.onRequestPost, { env, method: 'POST', cookie: await sessionFor(env, 'u1'), params: { id: booking.id } })).status).toBe(403);
    expect((await send(booking.id, { recipient: 'someone' })).status).toBe(400);

    await db.prepare("INSERT INTO email_templates (key, subject, body_text, is_enabled, updated_at, title, body) VALUES ('booking_invoice', 's', 't', 0, 'x', 'T', 'B')").run();
    const off = await send(booking.id);
    expect(off.body.details).toEqual({ code: 'disabled' });
    expect((await db.prepare('SELECT COUNT(*) AS c FROM invoices').first<{ c: number }>())?.c).toBe(0);
    await db.prepare("DELETE FROM email_templates WHERE key = 'booking_invoice'").run();

    await db.prepare('UPDATE bookings SET total_amount_pence = 0 WHERE id = ?').bind(booking.id).run();
    expect((await send(booking.id)).body.error).toBe('This booking is free of charge');
    await db.prepare("UPDATE bookings SET status = 'cancelled', total_amount_pence = 2000 WHERE id = ?").bind(booking.id).run();
    expect((await send(booking.id)).status).toBe(400);
    expect((await send('nope')).status).toBe(404);
  });
});
