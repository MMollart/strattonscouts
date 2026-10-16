import type { Env } from '../../_lib/http';
import { error, json, now } from '../../_lib/http';
import { getAuthUser } from '../../_lib/auth';
import { recordAudit } from '../../_lib/audit';
import { canManageFeed, type CalendarFeedRow } from '../../_lib/calendar';

/** Revoke a feed: its URL stops working straight away. The record is kept for the history. */
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const feed = await env.DB.prepare('SELECT * FROM calendar_feeds WHERE id = ?').bind(String(params.id)).first<CalendarFeedRow>();
  if (!feed || !(await canManageFeed(env, user, feed))) return error('Calendar link not found', 404);
  if (feed.revoked_at) return json({ ok: true });
  const stamp = now();
  await env.DB.prepare('UPDATE calendar_feeds SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(stamp, user.id, stamp, feed.id)
    .run();
  await recordAudit(env, {
    actor: user,
    action: 'calendar.feed_revoked',
    entityType: 'calendar_subscription',
    entityId: feed.id,
    entityLabel: feed.name,
    organisationId: feed.organisation_id,
  });
  return json({ ok: true });
};
