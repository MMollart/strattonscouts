import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { listInvoices, sendInvoice } from '../../../../_lib/invoices';

// Admin: the invoices issued for a booking, newest first.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  return json(await listInvoices(env, String(params.id)));
};

// Admin: email the hirer an invoice. Body: { recipient?: 'customer' | 'organisation' }
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  let body: { recipient?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as { recipient?: unknown };
  } catch {
    return error('Invalid JSON body');
  }
  const recipient = body.recipient ?? 'customer';
  if (recipient !== 'customer' && recipient !== 'organisation') return error('recipient must be "customer" or "organisation"', 400);

  const result = await sendInvoice(env, user, String(params.id), recipient);
  if (!result.ok) return error(result.message, result.status, result.code ? { code: result.code } : undefined);
  return json({ ok: result.status !== 'failed', status: result.status, to: result.to, reissued: result.reissued, invoice: result.invoice });
};
