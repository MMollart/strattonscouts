import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { bookingCalendarEvent, buildCalendar, foldLine, googleCalendarUrl, icsEscape, icsLocal, outlookCalendarUrl } from '@shared/ical';
import * as feedsApi from '../functions/api/calendar-feeds/index';
import * as feedApi from '../functions/api/calendar-feeds/[id]';
import * as regenerateApi from '../functions/api/calendar-feeds/[id]/regenerate';
import * as publicFeedApi from '../functions/api/feeds/[token]';
import * as bookingIcsApi from '../functions/api/bookings/[id]/calendar';

describe('iCalendar output (FR17)', () => {
  it('escapes text and folds long lines without splitting characters', () => {
    expect(icsEscape('Hall, kitchen; and\\or\nfield')).toBe('Hall\\, kitchen\\; and\\\\or\\nfield');
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(long);
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('writes UK local times either side of the clocks changing', () => {
    expect(icsLocal('2027-01-10T18:00:00.000Z')).toBe('20270110T180000');
    expect(icsLocal('2027-07-10T18:00:00.000Z')).toBe('20270710T190000');
    // 28 March 2027: 00:30 UTC is 00:30 GMT, 01:30 UTC is 02:30 BST.
    expect(icsLocal('2027-03-28T00:30:00.000Z')).toBe('20270328T003000');
    expect(icsLocal('2027-03-28T01:30:00.000Z')).toBe('20270328T023000');
    // 31 October 2027: 00:30 UTC is 01:30 BST, 01:30 UTC is 01:30 GMT.
    expect(icsLocal('2027-10-31T00:30:00.000Z')).toBe('20271031T013000');
    expect(icsLocal('2027-10-31T01:30:00.000Z')).toBe('20271031T013000');
  });

  it('builds a calendar with the London time zone and booking details only', () => {
    const venue = { name: 'Stratton Scouts', address: '1 Hut Lane', baseUrl: 'https://book.example', host: 'book.example' };
    const e = bookingCalendarEvent(
      { id: 'bk1', reference: 'SS-ABC', resource_name: 'Main Hall', starts_at: '2027-07-10T18:00:00.000Z', ends_at: '2027-07-10T20:00:00.000Z', status: 'provisional', updated_at: '2027-01-01T00:00:00.000Z' },
      venue,
    );
    expect(e.summary).toBe('Main Hall (provisional)');
    expect(e.status).toBe('TENTATIVE');
    expect(e.location).toBe('Main Hall, Stratton Scouts, 1 Hut Lane');
    const ics = buildCalendar({ name: 'Test', events: [e], now: '2027-01-02T00:00:00.000Z' });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/London');
    expect(ics).toContain('DTSTART;TZID=Europe/London:20270710T190000');
    expect(ics).toContain('DTEND;TZID=Europe/London:20270710T210000');
    expect(ics).toContain('UID:bk1@book.example');
    expect(ics).toContain('Booking reference: SS-ABC');

    const g = new URL(googleCalendarUrl(e));
    expect(g.searchParams.get('dates')).toBe('20270710T180000Z/20270710T200000Z');
    expect(g.searchParams.get('ctz')).toBe('Europe/London');
    const o = new URL(outlookCalendarUrl(e));
    expect(o.host).toBe('outlook.office.com');
    expect(o.searchParams.get('startdt')).toBe('2027-07-10T18:00:00.000Z');
    expect(new URL(outlookCalendarUrl(e, 'live')).host).toBe('outlook.live.com');
  });
});

describe('calendar downloads and subscriptions (FR17)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;

  const book = (id: string, o: { user?: string; resource?: string; status?: string; starts?: string; ends?: string; org?: string | null; expires?: string | null }) =>
    db.prepare(
      `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model, unit_price_pence, total_amount_pence,
                             organisation_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'cat_scouts', 'hourly', 0, 0, ?, ?, '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
    )
      .bind(id, `SS-${id.toUpperCase()}`, o.user ?? 'u1', o.resource ?? 'res_main', o.starts ?? '2099-07-10T18:00:00.000Z', o.ends ?? '2099-07-10T20:00:00.000Z',
        o.status ?? 'confirmed', o.org ?? null, o.expires ?? null)
      .run();

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addUser(db, 'u2');
    await addUser(db, 'mgr');
    await addAdmin(db, 'booker', 'booking_admin');
    await addAdmin(db, 'viewer', 'viewer');
    await db.prepare(
      `INSERT INTO organisations (id, name, organisation_type_id, pricing_category_id, contact_email, created_by, created_at, updated_at)
       VALUES ('org1', '1st Stratton Cubs', (SELECT id FROM organisation_types LIMIT 1), 'cat_scouts', 'cubs@example.com', 'mgr', 'x', 'x')`,
    ).run();
    await db.batch([
      db.prepare("INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES ('org1', 'mgr', 'manager', 'x', 'x')"),
      db.prepare("INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES ('org1', 'u1', 'member', 'x', 'x')"),
    ]);
    await book('a', {});
    await book('b', { status: 'cancelled' });
    await book('c', { resource: 'res_kitchen', org: 'org1', starts: '2099-08-01T09:00:00.000Z', ends: '2099-08-01T11:00:00.000Z' });
    await book('d', { user: 'u2', resource: 'res_field', status: 'provisional', expires: '2020-01-01T00:00:00.000Z' });
    await book('e', { user: 'u2', resource: 'res_whole', status: 'pending_approval', starts: '2099-09-01T09:00:00.000Z', ends: '2099-09-01T11:00:00.000Z' });
  });
  afterEach(async () => {
    await dispose();
  });

  const create = async (who: string, body: Record<string, unknown>) => call(feedsApi.onRequestPost, { env, cookie: await sessionFor(env, who), body });
  const fetchFeed = async (url: string) => {
    const token = url.split('/api/feeds/')[1];
    const res = await publicFeedApi.onRequestGet({ env, request: new Request(url), params: { token } } as never);
    return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
  };

  it('downloads a booking as an .ics file for people who can see it', async () => {
    const own = await call(bookingIcsApi.onRequestGet, { env, cookie: await sessionFor(env, 'u1'), params: { id: 'c' } });
    expect(own.status).toBe(200);
    expect(own.body).toContain('SUMMARY:Kitchen: 1st Stratton Cubs');
    expect(own.body).toContain('DTSTART;TZID=Europe/London:20990801T100000');
    expect(own.body).toContain('STATUS:CONFIRMED');
    // The manager of the organisation can see it; an unrelated customer cannot.
    expect((await call(bookingIcsApi.onRequestGet, { env, cookie: await sessionFor(env, 'mgr'), params: { id: 'c' } })).status).toBe(200);
    expect((await call(bookingIcsApi.onRequestGet, { env, cookie: await sessionFor(env, 'u2'), params: { id: 'c' } })).status).toBe(403);
    // A cancelled booking downloads as cancelled, so importing it removes the entry.
    expect((await call(bookingIcsApi.onRequestGet, { env, cookie: await sessionFor(env, 'u1'), params: { id: 'b' } })).body).toContain('STATUS:CANCELLED');
  });

  it('gives each customer a private feed of their bookings that follows changes', async () => {
    const res = await create('u1', { kind: 'user' });
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\/api\/feeds\/[0-9a-f]{64}\.ics$/);
    expect(JSON.stringify(res.body.feed)).not.toContain(res.body.url.split('/api/feeds/')[1].slice(0, 20));

    let feed = await fetchFeed(res.body.url);
    expect(feed.status).toBe(200);
    expect(feed.type).toContain('text/calendar');
    expect(feed.text).toContain('UID:a@');
    expect(feed.text).toContain('UID:c@');
    expect(feed.text).not.toContain('UID:b@'); // cancelled
    expect(feed.text).not.toContain('UID:e@'); // someone else's

    // An amendment moves the same entry; a cancellation removes it.
    await db.prepare("UPDATE bookings SET starts_at = '2099-07-11T18:00:00.000Z', ends_at = '2099-07-11T20:00:00.000Z', updated_at = '2027-02-01T00:00:00.000Z' WHERE id = 'a'").run();
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = 'c'").run();
    feed = await fetchFeed(res.body.url);
    expect(feed.text).toContain('DTSTART;TZID=Europe/London:20990711T190000');
    expect(feed.text).not.toContain('UID:c@');
    expect(feed.text).not.toMatch(/@example\.com|User u1|hourly/);

    const listed = await call(feedsApi.onRequestGet, { env, cookie: await sessionFor(env, 'u1') });
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).not.toHaveProperty('token_hash');
    expect(listed.body[0].last_used_at).toBeTruthy();
  });

  it('regenerates and revokes feed URLs', async () => {
    const res = await create('u1', { kind: 'user', name: 'Phone' });
    const id = res.body.feed.id;
    expect((await call(regenerateApi.onRequestPost, { env, cookie: await sessionFor(env, 'u2'), params: { id }, body: {} })).status).toBe(404);
    const again = await call(regenerateApi.onRequestPost, { env, cookie: await sessionFor(env, 'u1'), params: { id }, body: {} });
    expect(again.status).toBe(200);
    expect((await fetchFeed(res.body.url)).status).toBe(404);
    expect((await fetchFeed(again.body.url)).status).toBe(200);

    expect((await call(feedApi.onRequestDelete, { env, cookie: await sessionFor(env, 'u1'), params: { id }, method: 'DELETE' })).status).toBe(200);
    expect((await fetchFeed(again.body.url)).status).toBe(404);
    expect((await call(regenerateApi.onRequestPost, { env, cookie: await sessionFor(env, 'u1'), params: { id }, body: {} })).status).toBe(409);
    expect((await fetchFeed('http://localhost/api/feeds/not-a-token.ics')).status).toBe(404);

    const actions = await db.prepare("SELECT action FROM audit_events WHERE entity_type = 'calendar_subscription' ORDER BY created_at, rowid").all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual(['calendar.feed_created', 'calendar.feed_regenerated', 'calendar.feed_revoked']);
  });

  it('lets organisation managers, and only managers, subscribe to the organisation’s bookings', async () => {
    expect((await create('u1', { kind: 'organisation', organisation_id: 'org1' })).status).toBe(403);
    const res = await create('mgr', { kind: 'organisation', organisation_id: 'org1' });
    expect(res.status).toBe(201);
    expect(res.body.feed.name).toBe('1st Stratton Cubs bookings');
    const feed = await fetchFeed(res.body.url);
    expect(feed.text).toContain('UID:c@');
    expect(feed.text).not.toContain('UID:a@');
    expect(feed.text).not.toContain('User u1'); // no customer names

    const listed = await call(feedsApi.onRequestGet, { env, cookie: await sessionFor(env, 'mgr'), path: '/api/calendar-feeds?organisation_id=org1' });
    expect(listed.body).toHaveLength(1);
    expect((await call(feedsApi.onRequestGet, { env, cookie: await sessionFor(env, 'u1'), path: '/api/calendar-feeds?organisation_id=org1' })).status).toBe(403);

    // A manager who steps down stops their feed working.
    await db.prepare("UPDATE organisation_memberships SET role = 'member' WHERE user_id = 'mgr'").run();
    expect((await fetchFeed(res.body.url)).status).toBe(404);
  });

  it('gives Super and Booking Admins venue feeds for chosen resources', async () => {
    expect((await create('viewer', { kind: 'admin' })).status).toBe(403);
    expect((await create('u1', { kind: 'admin' })).status).toBe(403);

    const all = await create('booker', { kind: 'admin' });
    let feed = await fetchFeed(all.body.url);
    for (const id of ['a', 'c', 'e']) expect(feed.text).toContain(`UID:${id}@`);
    expect(feed.text).not.toContain('UID:d@'); // expired hold
    expect(feed.text).toContain('Whole Venue (awaiting approval)');
    expect(feed.text).not.toMatch(/1st Stratton Cubs|User u/);

    // Choosing the whole venue includes everything that is part of it.
    const whole = await create('booker', { kind: 'admin', resource_ids: ['res_whole'] });
    feed = await fetchFeed(whole.body.url);
    for (const id of ['a', 'c', 'e']) expect(feed.text).toContain(`UID:${id}@`);
    const kitchen = await create('booker', { kind: 'admin', resource_ids: ['res_kitchen'], show_names: true });
    feed = await fetchFeed(kitchen.body.url);
    expect(feed.text).toContain('UID:c@');
    expect(feed.text).not.toContain('UID:a@');
    expect(feed.text).toContain('SUMMARY:Kitchen: 1st Stratton Cubs');
    expect((await create('booker', { kind: 'admin', resource_ids: ['res_nope'] })).status).toBe(400);

    // Administrators can see and revoke anyone's feed.
    const mine = await create('u1', { kind: 'user' });
    const everyone = await call(feedsApi.onRequestGet, { env, cookie: await sessionFor(env, 'booker'), path: '/api/calendar-feeds?scope=all' });
    expect(everyone.body.map((f: { owner_id: string }) => f.owner_id)).toContain('u1');
    expect((await call(feedsApi.onRequestGet, { env, cookie: await sessionFor(env, 'viewer'), path: '/api/calendar-feeds?scope=all' })).status).toBe(403);
    expect((await call(feedApi.onRequestDelete, { env, cookie: await sessionFor(env, 'booker'), params: { id: mine.body.feed.id }, method: 'DELETE' })).status).toBe(200);
    expect((await fetchFeed(mine.body.url)).status).toBe(404);

    // An administrator who loses the role stops their venue feed working.
    await db.prepare("DELETE FROM user_roles WHERE user_id = 'booker'").run();
    expect((await fetchFeed(all.body.url)).status).toBe(404);
  });
});
