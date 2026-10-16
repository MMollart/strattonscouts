import type { Env } from '../../_lib/http';
import { now } from '../../_lib/http';
import { sha256Hex } from '../../_lib/crypto';
import { calendarResponse, feedStillAllowed, renderFeed, venueInfo, type CalendarFeedRow } from '../../_lib/calendar';

const notFound = () =>
  new Response('This calendar link is not valid. It may have been revoked or replaced.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });

/**
 * Public, read-only iCalendar subscription feed (FR17 §2.3). The secret in
 * the URL is the only credential, so an unknown, revoked or no-longer-allowed
 * feed gets the same 404 and nothing is said about why.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const token = String(params.token ?? '').replace(/\.ics$/i, '');
  if (!/^[0-9a-f]{64}$/.test(token)) return notFound();
  const feed = await env.DB.prepare('SELECT * FROM calendar_feeds WHERE token_hash = ?').bind(await sha256Hex(token)).first<CalendarFeedRow>();
  if (!feed || !(await feedStillAllowed(env, feed))) return notFound();

  const body = await renderFeed(env, feed, await venueInfo(env, request));
  // Note use at most hourly, so a busy calendar app does not write on every poll.
  const stamp = now();
  if (!feed.last_used_at || Date.parse(stamp) - Date.parse(feed.last_used_at) > 3_600_000) {
    await env.DB.prepare('UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?').bind(stamp, feed.id).run();
  }
  return calendarResponse(body, 'bookings.ics', 'inline');
};
