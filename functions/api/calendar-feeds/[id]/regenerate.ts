import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { getAuthUser } from '../../../_lib/auth';
import { recordAudit } from '../../../_lib/audit';
import { canManageFeed, feedUrl, issueFeedToken, venueInfo, type CalendarFeedRow } from '../../../_lib/calendar';

/**
 * Replace a feed's URL: the old one stops working at once and the new one is
 * returned (only now). Use it if a link may have been shared by mistake.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const feed = await env.DB.prepare('SELECT * FROM calendar_feeds WHERE id = ?').bind(String(params.id)).first<CalendarFeedRow>();
  if (!feed || !(await canManageFeed(env, user, feed))) return error('Calendar link not found', 404);
  if (feed.revoked_at) return error('This calendar link has been revoked. Create a new one instead.', 409);
  const { token, hash, hint } = await issueFeedToken();
  const stamp = now();
  const res = await env.DB.prepare(
    'UPDATE calendar_feeds SET token_hash = ?, token_hint = ?, regenerated_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL',
  )
    .bind(hash, hint, stamp, stamp, feed.id)
    .run();
  if (!res.meta.changes) return error('This calendar link has been revoked. Create a new one instead.', 409);
  await recordAudit(env, {
    actor: user,
    action: 'calendar.feed_regenerated',
    entityType: 'calendar_subscription',
    entityId: feed.id,
    entityLabel: feed.name,
    organisationId: feed.organisation_id,
  });
  return json({ url: feedUrl(await venueInfo(env, request), token), token_hint: hint });
};
