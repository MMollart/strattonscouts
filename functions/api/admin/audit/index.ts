import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { getAuthUser } from '../../../_lib/auth';
import { sealAuditEvents } from '../../../_lib/audit';
import { auditAccess, filtersFromUrl, searchAudit } from '../../../_lib/audit-query';

/**
 * Admin: search the audit history (FR11), newest first. Also serves a
 * record's own History section (entity_type + entity_id, or booking_id).
 * Pages with ?before=<seq>. Viewers get the restricted view (no values).
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const access = auditAccess(user);
  if (!access) return error('Not authorised', 403);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const before = Number(url.searchParams.get('before')) || null;
  // Seal anything recorded since the scheduler last ran, so what is shown is covered by the chain.
  await sealAuditEvents(env);
  const events = await searchAudit(env, filtersFromUrl(url), { access, beforeSeq: before, limit: limit + 1 });
  const more = events.length > limit;
  const page = more ? events.slice(0, limit) : events;
  return json({ access, events: page, next_before: more ? page[page.length - 1].seq : null });
};
