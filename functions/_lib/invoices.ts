import type { Env } from './http';
import { newId, now } from './http';
import type { AuthUser } from './auth';
import { bookingTimeParams, loadTemplate, sendEmail } from './email';
import { getIntSetting } from './settings';
import { addDays, londonToday } from '@shared/londonTime';
import { formatGBP } from '@shared/pricing';

/**
 * Invoices (migration 0023). An administrator sends the hirer an invoice for
 * a confirmed, chargeable booking. The invoice keeps a snapshot of the price;
 * sending again while the booking's price is unchanged resends the same
 * invoice, and a changed price (after an amendment) issues a new number.
 */

export interface Invoice {
  id: string;
  invoice_number: string;
  booking_id: string;
  amount_pence: number;
  base_amount_pence: number;
  discount_pence: number;
  discount_label: string | null;
  issued_at: string;
  due_date: string;
  last_sent_at: string;
  send_count: number;
}

export type InvoiceRecipient = 'customer' | 'organisation';

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** A YYYY-MM-DD date (or an instant) as "Mon, 29 Dec 2025" in UK time. */
function ukDate(value: string): string {
  return dateFmt.format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value));
}

export async function listInvoices(env: Env, bookingId: string): Promise<Invoice[]> {
  const rows = await env.DB.prepare(
    `SELECT id, invoice_number, booking_id, amount_pence, base_amount_pence, discount_pence, discount_label, issued_at, due_date, last_sent_at, send_count
     FROM invoices WHERE booking_id = ? ORDER BY sequence DESC`,
  )
    .bind(bookingId)
    .all<Invoice>();
  return rows.results;
}

type SendResult =
  | { ok: true; invoice: Invoice; reissued: boolean; to: string; status: 'sent' | 'failed' | 'duplicate' }
  | { ok: false; status: number; message: string; code?: string };

export async function sendInvoice(env: Env, user: AuthUser, bookingId: string, recipient: InvoiceRecipient): Promise<SendResult> {
  const b = await env.DB.prepare(
    `SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.total_amount_pence,
            COALESCE(b.base_amount_pence, b.total_amount_pence) AS base_amount_pence, COALESCE(b.discount_pence, 0) AS discount_pence, b.discount_label,
            r.name AS resource_name, u.email, u.full_name, o.name AS organisation_name, o.contact_email AS organisation_email
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id WHERE b.id = ?`,
  )
    .bind(bookingId)
    .first<{
      id: string; reference: string; status: string; starts_at: string; ends_at: string; total_amount_pence: number;
      base_amount_pence: number; discount_pence: number; discount_label: string | null;
      resource_name: string; email: string; full_name: string; organisation_name: string | null; organisation_email: string | null;
    }>();
  if (!b) return { ok: false, status: 404, message: 'Booking not found' };
  if (b.status !== 'confirmed') return { ok: false, status: 400, message: 'Invoices can only be sent for confirmed bookings' };
  if (b.total_amount_pence === 0) return { ok: false, status: 400, message: 'This booking is free of charge' };
  if (recipient === 'organisation' && !b.organisation_email) return { ok: false, status: 400, message: 'This booking is not for an organisation' };
  // Check before issuing, so a switched-off template never uses up a number.
  if (!(await loadTemplate(env, 'booking_invoice')).is_enabled) {
    return { ok: false, status: 400, message: 'The invoice email is turned off in Email templates', code: 'disabled' };
  }

  const ts = now();
  const latest = (await listInvoices(env, b.id))[0];
  const unchanged =
    latest &&
    latest.amount_pence === b.total_amount_pence &&
    latest.base_amount_pence === b.base_amount_pence &&
    latest.discount_pence === b.discount_pence;

  let invoice: Invoice;
  if (unchanged) {
    await env.DB.batch([
      env.DB.prepare('UPDATE invoices SET last_sent_at = ?, send_count = send_count + 1 WHERE id = ?').bind(ts, latest.id),
      bookingEvent(env, b.id, user.id, { invoice_number: latest.invoice_number, amount_pence: latest.amount_pence, resent: true }, ts),
    ]);
    invoice = { ...latest, last_sent_at: ts, send_count: latest.send_count + 1 };
  } else {
    const id = newId('inv');
    const dueDate = addDays(londonToday(), await getIntSetting(env, 'invoice_due_days', 14));
    // The next number is worked out inside the INSERT, so two sends at once
    // cannot take the same one (the UNIQUE constraint refuses the loser).
    const [inserted] = await env.DB.batch<{ invoice_number: string }>([
      env.DB.prepare(
        `INSERT INTO invoices (id, sequence, invoice_number, booking_id, amount_pence, base_amount_pence, discount_pence, discount_label, issued_at, due_date, issued_by, last_sent_at, send_count)
         SELECT ?, n, 'INV-' || printf('%06d', n), ?, ?, ?, ?, ?, ?, ?, ?, ?, 1 FROM (SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM invoices)
         RETURNING invoice_number`,
      ).bind(id, b.id, b.total_amount_pence, b.base_amount_pence, b.discount_pence, b.discount_label, ts, dueDate, user.id, ts),
      env.DB.prepare(
        `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
         SELECT ?, ?, 'invoice_sent', ?, json_object('to', json_object('invoice_number', invoice_number, 'amount_pence', amount_pence, 'due_date', due_date)), ?
         FROM invoices WHERE id = ?`,
      ).bind(newId('bev'), b.id, user.id, ts, id),
    ]);
    invoice = {
      id,
      invoice_number: inserted.results[0].invoice_number,
      booking_id: b.id,
      amount_pence: b.total_amount_pence,
      base_amount_pence: b.base_amount_pence,
      discount_pence: b.discount_pence,
      discount_label: b.discount_label,
      issued_at: ts,
      due_date: dueDate,
      last_sent_at: ts,
      send_count: 1,
    };
  }

  const to = recipient === 'organisation' ? b.organisation_email! : b.email;
  const discounted = invoice.discount_pence > 0;
  const result = await sendEmail(env, {
    to,
    bookingId: b.id,
    template: 'booking_invoice',
    params: {
      customer_name: b.full_name,
      organisation_name: b.organisation_name ?? '',
      booking_reference: b.reference,
      resource_name: b.resource_name,
      ...bookingTimeParams(b.starts_at, b.ends_at),
      booking_cost: formatGBP(invoice.amount_pence),
      booking_status: b.status,
      invoice_number: invoice.invoice_number,
      invoice_date: ukDate(invoice.issued_at),
      invoice_due_date: ukDate(invoice.due_date),
      invoice_list_price: discounted ? formatGBP(invoice.base_amount_pence) : '',
      invoice_discount: discounted ? `−${formatGBP(invoice.discount_pence)} (${invoice.discount_label ?? 'Discount'})` : '',
    },
  });
  // The template was checked above; it can only be off here if switched off mid-send.
  if (result.status === 'disabled') return { ok: false, status: 400, message: 'The invoice email is turned off in Email templates', code: 'disabled' };
  return { ok: true, invoice, reissued: !unchanged && !!latest, to, status: result.status };
}

function bookingEvent(env: Env, bookingId: string, actorId: string, to: Record<string, unknown>, ts: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES (?, ?, 'invoice_sent', ?, ?, ?)`,
  ).bind(newId('bev'), bookingId, actorId, JSON.stringify({ to }), ts);
}
