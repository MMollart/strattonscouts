import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { can, getAuthUser } from '../../../_lib/auth';
import { bookingAccess } from '../../../_lib/booking-access';

/**
 * The agreements accepted for a booking (FR20 §5.6): which version, its
 * exact text, when and by whom, and the typed name. The drawn signature and
 * typed name are shown to the customer, organisation managers and
 * administrators who manage bookings; Viewers and other organisation members
 * see what was accepted and when, but not the signature.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  const booking = await env.DB.prepare('SELECT user_id, organisation_id FROM bookings WHERE id = ?').bind(id).first<{ user_id: string; organisation_id: string | null }>();
  if (!booking) return error('Booking not found', 404);
  const access = await bookingAccess(env, user, booking);
  if (!access.canView) return error('Not authorised', 403);
  const full = booking.user_id === user.id || access.canManage || can(user, 'agreements.manage');

  const rows = await env.DB.prepare(
    `SELECT a.id, a.amendment_id, a.template_id, a.version_id, a.content_hash, a.accepted_at,
            v.title, v.version_number, v.body, v.effective_from, v.pdf_key IS NOT NULL AS has_pdf,
            s.signed_name, s.signature_image, s.on_behalf_of, u.full_name AS accepted_by_name
     FROM agreement_acceptances a
     JOIN agreement_versions v ON v.id = a.version_id
     JOIN agreement_signatures s ON s.id = a.signature_id
     JOIN users u ON u.id = a.accepted_by
     WHERE a.booking_id = ? ORDER BY a.accepted_at, v.title`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return json(
    rows.results.map((r) => ({
      id: r.id,
      amendment_id: r.amendment_id,
      template_id: r.template_id,
      version_id: r.version_id,
      title: r.title,
      version_number: r.version_number,
      body: r.body,
      effective_from: r.effective_from,
      has_pdf: !!r.has_pdf,
      content_hash: r.content_hash,
      accepted_at: r.accepted_at,
      accepted_by_name: r.accepted_by_name,
      on_behalf: !!r.on_behalf_of,
      signed_name: full ? r.signed_name : null,
      signature_image: full ? r.signature_image : null,
      has_drawn_signature: !!r.signature_image,
    })),
  );
};
