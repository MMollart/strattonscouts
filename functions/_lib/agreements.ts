import type { Env } from './http';
import { error, newId, now } from './http';
import { ANCESTORS_SQL } from './availability-sql';
import { sha256Hex } from './crypto';
import type { AgreementAcceptanceInput } from '@shared/validation';

/**
 * Booking agreements (Release 3 / FR20). A template applies to every booking
 * (applies_to_all) or to the resources it is assigned to and everything that
 * is part of them. The version a customer must accept is the latest one whose
 * effective date has passed.
 */

export interface RequiredAgreement {
  template_id: string;
  title: string;
  summary: string;
  version_id: string;
  version_number: number;
  body: string;
  effective_from: string;
  content_hash: string;
  has_pdf: boolean;
  /** Which of the requested resources it applies to. */
  resource_ids: string[];
}

/** The content a version's hash covers; an acceptance stores the same hash. */
export async function versionContentHash(v: { title: string; body: string; pdf_sha256: string | null }): Promise<string> {
  return sha256Hex(JSON.stringify({ title: v.title, body: v.body, pdf_sha256: v.pdf_sha256 }));
}

/** The latest version of each template in effect at `at`. */
const CURRENT_VERSION = `(SELECT v2.id FROM agreement_versions v2 WHERE v2.template_id = t.id AND v2.effective_from <= ?
                          ORDER BY v2.effective_from DESC, v2.version_number DESC LIMIT 1)`;

export async function requiredAgreements(env: Env, resourceIds: string[], at = now()): Promise<RequiredAgreement[]> {
  const ids = [...new Set(resourceIds)];
  if (!ids.length) return [];
  // Each resource with everything it is part of.
  const ancestors = await env.DB.batch<{ resource_id: string }>(ids.map((id) => env.DB.prepare(ANCESTORS_SQL).bind(id)));
  const lineage = new Map(ids.map((id, i) => [id, [id, ...ancestors[i].results.map((a) => a.resource_id)]]));
  const all = [...new Set([...lineage.values()].flat())];

  const [templates, assignments] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT t.id AS template_id, t.title, t.summary, t.applies_to_all, v.id AS version_id, v.version_number, v.body, v.effective_from,
              v.content_hash, v.pdf_key
       FROM agreement_templates t JOIN agreement_versions v ON v.id = ${CURRENT_VERSION}
       WHERE t.is_active = 1
         AND (t.applies_to_all = 1 OR t.id IN (SELECT template_id FROM resource_agreements WHERE resource_id IN (${all.map(() => '?').join(', ')})))
       ORDER BY t.applies_to_all DESC, t.title`,
    ).bind(at, ...all),
    env.DB.prepare(`SELECT template_id, resource_id FROM resource_agreements WHERE resource_id IN (${all.map(() => '?').join(', ')})`).bind(...all),
  ]);
  const assigned = new Map<string, Set<string>>();
  for (const a of assignments.results as { template_id: string; resource_id: string }[]) {
    if (!assigned.has(a.template_id)) assigned.set(a.template_id, new Set());
    assigned.get(a.template_id)!.add(a.resource_id);
  }
  return (templates.results as Record<string, unknown>[]).map((t) => {
    const on = assigned.get(t.template_id as string) ?? new Set<string>();
    return {
      template_id: t.template_id as string,
      title: t.title as string,
      summary: t.summary as string,
      version_id: t.version_id as string,
      version_number: t.version_number as number,
      body: t.body as string,
      effective_from: t.effective_from as string,
      content_hash: t.content_hash as string,
      has_pdf: !!t.pdf_key,
      resource_ids: t.applies_to_all ? ids : ids.filter((id) => lineage.get(id)!.some((r) => on.has(r))),
    };
  });
}

/**
 * Check what the customer accepted against what applies. Every applicable
 * version must have been accepted explicitly; if a newer version came into
 * effect while they were filling in the form, they are asked again.
 */
export function checkAcceptance(
  required: RequiredAgreement[],
  input: AgreementAcceptanceInput | null | undefined,
): { ok: true; accepted: RequiredAgreement[] } | { ok: false; response: Response } {
  if (!required.length) return { ok: true, accepted: [] };
  const given = new Set(input?.accepted ? input.version_ids : []);
  const missing = required.filter((r) => !given.has(r.version_id));
  if (missing.length || !input?.signed_name) {
    return {
      ok: false,
      response: error(
        missing.length
          ? `Please read and accept ${missing.map((m) => m.title).join(', ')} and type your full name to sign.`
          : 'Type your full name to sign the agreements.',
        400,
        { code: 'agreements_required', required: required.map(publicAgreement) },
      ),
    };
  }
  return { ok: true, accepted: required };
}

/** What a customer is shown before accepting. */
export function publicAgreement(r: RequiredAgreement) {
  return {
    template_id: r.template_id,
    title: r.title,
    summary: r.summary,
    version_id: r.version_id,
    version_number: r.version_number,
    body: r.body,
    effective_from: r.effective_from,
    has_pdf: r.has_pdf,
    resource_ids: r.resource_ids,
  };
}

export interface SignatureDraft {
  id: string;
  signedBy: string;
  onBehalfOf: string | null;
  signedName: string;
  image: string | null;
  at: string;
}

export function signatureDraft(input: AgreementAcceptanceInput, signedBy: string, customerId: string): SignatureDraft {
  return {
    id: newId('sig'),
    signedBy,
    onBehalfOf: customerId === signedBy ? null : customerId,
    signedName: input.signed_name.trim(),
    image: input.signature_image ?? null,
    at: now(),
  };
}

/**
 * Statements that store a signature and its acceptances. `bookings` names
 * each booking and the agreements that apply to it; rows are only written
 * if the booking exists, so they belong in the same batch as the booking
 * insert and disappear with it if the booking loses a race.
 */
export function acceptanceStatements(
  env: Env,
  sig: SignatureDraft,
  bookings: { bookingId: string; agreements: RequiredAgreement[] }[],
  amendmentId: string | null = null,
): D1PreparedStatement[] {
  const withAgreements = bookings.filter((b) => b.agreements.length);
  if (!withAgreements.length) return [];
  const ids = withAgreements.map((b) => b.bookingId);
  const out = [
    env.DB.prepare(
      `INSERT INTO agreement_signatures (id, signed_by, on_behalf_of, signed_name, signature_image, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id IN (${ids.map(() => '?').join(', ')}))`,
    ).bind(sig.id, sig.signedBy, sig.onBehalfOf, sig.signedName, sig.image, sig.at, ...ids),
  ];
  for (const b of withAgreements) {
    for (const a of b.agreements) {
      out.push(
        env.DB.prepare(
          `INSERT INTO agreement_acceptances (id, booking_id, amendment_id, template_id, version_id, content_hash, signature_id, accepted_by, accepted_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)`,
        ).bind(newId('acc'), b.bookingId, amendmentId, a.template_id, a.version_id, a.content_hash, sig.id, sig.signedBy, sig.at, b.bookingId),
      );
    }
  }
  return out;
}

/** The same for every booking of a recurring series, written in one statement per agreement. */
export function seriesAcceptanceStatements(env: Env, sig: SignatureDraft, seriesId: string, agreements: RequiredAgreement[]): D1PreparedStatement[] {
  if (!agreements.length) return [];
  return [
    env.DB.prepare(
      `INSERT INTO agreement_signatures (id, signed_by, on_behalf_of, signed_name, signature_image, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE series_id = ?)`,
    ).bind(sig.id, sig.signedBy, sig.onBehalfOf, sig.signedName, sig.image, sig.at, seriesId),
    ...agreements.map((a) =>
      env.DB.prepare(
        `INSERT INTO agreement_acceptances (id, booking_id, amendment_id, template_id, version_id, content_hash, signature_id, accepted_by, accepted_at)
         SELECT 'acc_' || lower(hex(randomblob(16))), id, NULL, ?, ?, ?, ?, ?, ? FROM bookings WHERE series_id = ?`,
      ).bind(a.template_id, a.version_id, a.content_hash, sig.id, sig.signedBy, sig.at, seriesId),
    ),
  ];
}

/** Version ids already accepted for a booking. */
export async function acceptedVersionIds(env: Env, bookingId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare('SELECT DISTINCT version_id FROM agreement_acceptances WHERE booking_id = ?').bind(bookingId).all<{ version_id: string }>();
  return new Set(rows.results.map((r) => r.version_id));
}
