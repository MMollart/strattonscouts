import type { Env } from './http';
import type { AuthUser } from './auth';
import { can, loadAccess } from './auth';
import { randomToken, sha256Hex } from './crypto';
import { getSetting } from './settings';
import { getMembershipRole } from './organisations';
import { activeBookingSql, resourceNamesSql } from './availability-sql';
import { bookingCalendarEvent, buildCalendar, type BookingCalendarInput } from '@shared/ical';

export type FeedKind = 'user' | 'organisation' | 'admin';

export interface CalendarFeedRow {
  id: string;
  kind: FeedKind;
  name: string;
  owner_id: string;
  organisation_id: string | null;
  resource_ids: string | null;
  show_names: number;
  token_hint: string;
  created_at: string;
  updated_at: string;
  regenerated_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** How far back a feed reaches; anything later is included. */
const FEED_HISTORY_DAYS = 90;
const FEED_LIMIT = 5000;

export interface Venue {
  name: string;
  address: string;
  baseUrl: string;
  host: string;
}

export async function venueInfo(env: Env, request: Request): Promise<Venue> {
  const baseUrl = (env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = new URL(request.url).host;
  }
  const [name, address] = await Promise.all([getSetting(env, 'venue_name'), getSetting(env, 'venue_address')]);
  return { name, address, baseUrl, host };
}

/**
 * A new secret for a feed URL. The token is 256 random bits; only its hash is
 * stored, so a database copy cannot be used to read anyone's calendar.
 */
export async function issueFeedToken(): Promise<{ token: string; hash: string; hint: string }> {
  const token = randomToken(32);
  return { token, hash: await sha256Hex(token), hint: token.slice(-4) };
}

export function feedUrl(venue: Venue, token: string): string {
  return `${venue.baseUrl}/api/feeds/${token}.ics`;
}

export function parseResourceIds(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Who may regenerate or revoke a feed: its owner, any manager of the
 * organisation for an organisation feed, and administrators with
 * calendar.manage for every feed.
 */
export async function canManageFeed(env: Env, user: AuthUser, feed: CalendarFeedRow): Promise<boolean> {
  if (feed.owner_id === user.id || can(user, 'calendar.manage')) return true;
  if (feed.kind === 'organisation' && feed.organisation_id) {
    return (await getMembershipRole(env, feed.organisation_id, user.id)) === 'manager';
  }
  return false;
}

/**
 * Whether the person who set the feed up may still see what it shows. A
 * feed stops working when its owner leaves the organisation's managers or
 * loses the administration permission, as well as when it is revoked.
 */
export async function feedStillAllowed(env: Env, feed: CalendarFeedRow): Promise<boolean> {
  if (feed.revoked_at) return false;
  if (feed.kind === 'organisation') {
    return !!feed.organisation_id && (await getMembershipRole(env, feed.organisation_id, feed.owner_id)) === 'manager';
  }
  if (feed.kind === 'admin') {
    const access = await loadAccess(env, feed.owner_id);
    return access.permissions.includes('calendar.manage') && access.permissions.includes('bookings.view');
  }
  return true;
}

/** A resource and everything that is part of it. */
async function withDescendants(env: Env, ids: string[]): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT id, parent_id FROM resources').all<{ id: string; parent_id: string | null }>();
  const children = new Map<string, string[]>();
  for (const r of rows.results) {
    if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r.id]);
  }
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return [...out];
}

interface FeedBookingRow extends BookingCalendarInput {
  organisation_name: string | null;
  customer_name: string;
}

/**
 * The iCalendar document for a feed: bookings that currently hold their
 * resource (confirmed, provisional or awaiting approval). Cancelled,
 * rejected and expired bookings are left out, so calendar apps remove them at
 * their next refresh, and amended bookings keep their UID so they move.
 */
export async function renderFeed(env: Env, feed: CalendarFeedRow, venue: Venue): Promise<string> {
  const binds: unknown[] = [new Date(Date.now() - FEED_HISTORY_DAYS * 86_400_000).toISOString()];
  let where: string;
  if (feed.kind === 'user') {
    where = 'b.user_id = ?';
    binds.push(feed.owner_id);
  } else if (feed.kind === 'organisation') {
    where = 'b.organisation_id = ?';
    binds.push(feed.organisation_id);
  } else {
    const chosen = parseResourceIds(feed.resource_ids);
    if (chosen) {
      const ids = await withDescendants(env, chosen);
      where = ids.length
        ? `EXISTS (SELECT 1 FROM booking_resources brc WHERE brc.booking_id = b.id AND brc.resource_id IN (${ids.map(() => '?').join(', ')}))`
        : '0';
      binds.push(...ids);
    } else {
      where = '1';
    }
  }
  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.starts_at, b.ends_at, b.status, b.updated_at,
            ${resourceNamesSql('b')} AS resource_name, o.name AS organisation_name, u.full_name AS customer_name
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE ${activeBookingSql('b')} AND b.ends_at >= ? AND ${where}
     ORDER BY b.starts_at
     LIMIT ${FEED_LIMIT}`,
  )
    .bind(...binds)
    .all<FeedBookingRow>();

  const who = (b: FeedBookingRow): string | null => {
    // A person's own feed may name the organisation they booked for.
    if (feed.kind === 'user') return b.organisation_name;
    // Shared feeds only name who booked when an administrator chose to.
    if (feed.kind === 'admin' && feed.show_names) return b.organisation_name ?? b.customer_name;
    return null;
  };
  return buildCalendar({
    name: `${venue.name}: ${feed.name}`,
    refreshHours: 1,
    events: rows.results.map((b) => bookingCalendarEvent(b, venue, who(b))),
  });
}

export function calendarResponse(body: string, filename: string, disposition: 'inline' | 'attachment'): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `${disposition}; filename="${filename}"`,
      'cache-control': 'private, max-age=300',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** A feed row for display: never the token or its hash. */
export function publicFeed(f: CalendarFeedRow & { owner_name?: string; organisation_name?: string | null }) {
  return {
    id: f.id,
    kind: f.kind,
    name: f.name,
    owner_id: f.owner_id,
    owner_name: f.owner_name ?? null,
    organisation_id: f.organisation_id,
    organisation_name: f.organisation_name ?? null,
    resource_ids: parseResourceIds(f.resource_ids),
    show_names: !!f.show_names,
    token_hint: f.token_hint,
    created_at: f.created_at,
    regenerated_at: f.regenerated_at,
    last_used_at: f.last_used_at,
    revoked_at: f.revoked_at,
  };
}
