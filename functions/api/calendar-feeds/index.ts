import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { can, getAuthUser } from '../../_lib/auth';
import { parseBody } from '../../_lib/request';
import { recordAudit } from '../../_lib/audit';
import { getMembershipRole } from '../../_lib/organisations';
import { feedUrl, issueFeedToken, publicFeed, venueInfo, type CalendarFeedRow } from '../../_lib/calendar';
import { calendarFeedCreateSchema } from '@shared/validation';

const MAX_ACTIVE_PER_OWNER = 10;

const LIST_SQL = `SELECT f.*, u.full_name AS owner_name, o.name AS organisation_name
  FROM calendar_feeds f JOIN users u ON u.id = f.owner_id LEFT JOIN organisations o ON o.id = f.organisation_id`;

/**
 * Calendar subscriptions (FR17 §2.3–2.5).
 *   (no query)              the signed-in user's own feeds
 *   ?organisation_id=…      an organisation's feeds, for its managers
 *   ?scope=all              every feed, for administrators with calendar.manage
 * Revoked feeds are included so people can see what was turned off.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const url = new URL(request.url);
  const orgId = url.searchParams.get('organisation_id');
  let rows;
  if (url.searchParams.get('scope') === 'all') {
    if (!can(user, 'calendar.manage')) return error('Not authorised', 403);
    rows = await env.DB.prepare(`${LIST_SQL} ORDER BY f.revoked_at IS NOT NULL, f.created_at DESC LIMIT 500`).all<CalendarFeedRow>();
  } else if (orgId) {
    if ((await getMembershipRole(env, orgId, user.id)) !== 'manager' && !can(user, 'calendar.manage')) return error('Not authorised', 403);
    rows = await env.DB.prepare(`${LIST_SQL} WHERE f.organisation_id = ? ORDER BY f.revoked_at IS NOT NULL, f.created_at DESC`).bind(orgId).all<CalendarFeedRow>();
  } else {
    rows = await env.DB.prepare(`${LIST_SQL} WHERE f.owner_id = ? ORDER BY f.revoked_at IS NOT NULL, f.created_at DESC`).bind(user.id).all<CalendarFeedRow>();
  }
  return json(rows.results.map(publicFeed));
};

/** Create a feed. The URL is returned once; only a hash of its secret is kept. */
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, calendarFeedCreateSchema);
  if (input instanceof Response) return input;

  let organisationId: string | null = null;
  let resourceIds: string[] | null = null;
  let name = input.name?.trim() || '';
  if (input.kind === 'organisation') {
    organisationId = input.organisation_id!;
    if ((await getMembershipRole(env, organisationId, user.id)) !== 'manager') {
      return error('Only managers of the organisation can set up its calendar', 403);
    }
    const org = await env.DB.prepare('SELECT name FROM organisations WHERE id = ?').bind(organisationId).first<{ name: string }>();
    if (!org) return error('Organisation not found', 404);
    name ||= `${org.name} bookings`;
  } else if (input.kind === 'admin') {
    if (!can(user, 'calendar.manage') || !can(user, 'bookings.view')) return error('Not authorised', 403);
    if (input.resource_ids?.length) {
      resourceIds = [...new Set(input.resource_ids)];
      const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM resources WHERE id IN (${resourceIds.map(() => '?').join(', ')})`)
        .bind(...resourceIds)
        .first<{ n: number }>();
      if ((found?.n ?? 0) !== resourceIds.length) return error('Unknown resource', 400);
    }
    name ||= resourceIds ? 'Venue bookings (chosen resources)' : 'Venue bookings (all resources)';
  } else {
    name ||= 'My bookings';
  }

  const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM calendar_feeds WHERE owner_id = ? AND revoked_at IS NULL').bind(user.id).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_PER_OWNER) return error(`You can have up to ${MAX_ACTIVE_PER_OWNER} calendar links. Revoke one you no longer use first.`, 400);

  const id = newId('cal');
  const { token, hash, hint } = await issueFeedToken();
  const stamp = now();
  const showNames = input.kind === 'admin' && input.show_names ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO calendar_feeds (id, kind, name, owner_id, organisation_id, resource_ids, show_names, token_hash, token_hint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.kind, name, user.id, organisationId, resourceIds ? JSON.stringify(resourceIds) : null, showNames, hash, hint, stamp, stamp)
    .run();
  await recordAudit(env, {
    actor: user,
    action: 'calendar.feed_created',
    entityType: 'calendar_subscription',
    entityId: id,
    entityLabel: name,
    after: { kind: input.kind, name, resource_ids: resourceIds, show_names: !!showNames },
    organisationId,
  });
  const feed = await env.DB.prepare(`${LIST_SQL} WHERE f.id = ?`).bind(id).first<CalendarFeedRow>();
  return json({ feed: publicFeed(feed!), url: feedUrl(await venueInfo(env, request), token) }, 201);
};
