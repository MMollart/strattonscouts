import type { Env } from './http';
import { decryptAtRest } from './crypto';
import { effectiveStatusSql } from './availability-sql';

/** Organisation details plus members (and invitations when requested). */
export async function loadOrganisation(env: Env, id: string, opts: { includeInvitations: boolean }) {
  const org = await env.DB.prepare(
    `SELECT o.id, o.name, o.organisation_type_id, t.label AS organisation_type, o.pricing_category_id,
            pc.label AS category_label, o.contact_email, o.contact_phone_encrypted, o.created_at
     FROM organisations o
     JOIN organisation_types t ON t.id = o.organisation_type_id
     JOIN pricing_categories pc ON pc.id = o.pricing_category_id
     WHERE o.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown> & { contact_phone_encrypted: string | null }>();
  if (!org) return null;
  const members = await env.DB.prepare(
    `SELECT u.id AS user_id, u.full_name, u.email, m.role, m.created_at
     FROM organisation_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organisation_id = ? ORDER BY m.role, u.full_name`,
  )
    .bind(id)
    .all();
  const invitations = opts.includeInvitations
    ? (
        await env.DB.prepare(
          `SELECT id, email, role, CASE WHEN status = 'pending' AND expires_at <= ? THEN 'expired' ELSE status END AS status,
                  created_at, expires_at
           FROM organisation_invitations WHERE organisation_id = ? ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(new Date().toISOString(), id)
          .all()
      ).results
    : undefined;
  const { contact_phone_encrypted, ...rest } = org;
  return {
    ...rest,
    contact_phone: await decryptAtRest(contact_phone_encrypted, env.DATA_ENCRYPTION_KEY ?? ''),
    members: members.results,
    ...(invitations ? { invitations } : {}),
  };
}

/** Bookings that belong to an organisation, newest first. */
export async function loadOrganisationBookings(env: Env, organisationId: string) {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.resource_id, r.name AS resource_name, b.starts_at, b.ends_at, ${effectiveStatusSql('b')} AS status, b.expires_at,
            b.total_amount_pence, b.created_at, u.full_name AS booked_by
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     WHERE b.organisation_id = ? ORDER BY b.starts_at DESC LIMIT 500`,
  )
    .bind(organisationId)
    .all();
  return rows.results;
}
