import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { addDays, londonToday } from '@shared/londonTime';
import * as bookingsApi from '../functions/api/bookings/index';
import * as seriesApi from '../functions/api/series/index';
import * as amendApi from '../functions/api/bookings/[id]/amendments/index';
import * as quoteApi from '../functions/api/bookings/[id]/amendments/quote';
import * as bookingAgreements from '../functions/api/bookings/[id]/agreements';
import * as requiredApi from '../functions/api/agreements/required';
import * as pdfApi from '../functions/api/agreements/versions/[id]/pdf';
import * as templatesApi from '../functions/api/admin/agreements/index';
import * as templateOne from '../functions/api/admin/agreements/[id]';
import * as versionsApi from '../functions/api/admin/agreements/[id]/versions';
import * as acceptancesApi from '../functions/api/admin/agreements/[id]/acceptances';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;
let customer: string;
let superAdmin: string;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1');
  await addAdmin(db, 'super', 'super_admin');
  await addAdmin(db, 'booker', 'booking_admin');
  await addAdmin(db, 'viewer', 'viewer');
  customer = await sessionFor(env, 'u1');
  superAdmin = await sessionFor(env, 'super');
});
afterEach(async () => {
  await dispose();
});

const inDays = (days: number, from = 10, to = 12) => {
  const d = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  return { starts_at: `${d}T${String(from).padStart(2, '0')}:00:00.000Z`, ends_at: `${d}T${String(to).padStart(2, '0')}:00:00.000Z` };
};
const past = () => new Date(Date.now() - 86_400_000).toISOString();
const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

async function agreement(title: string, resourceIds: string[], body = `The ${title} terms. Leave the hall tidy.`, extra: Record<string, unknown> = {}) {
  const t = await call(templatesApi.onRequestPost, { env, cookie: superAdmin, body: { title, resource_ids: resourceIds, ...extra } });
  expect(t.status).toBe(201);
  const v = await call(versionsApi.onRequestPost, { env, cookie: superAdmin, params: { id: t.body.id }, body: { body, effective_from: past() } });
  expect(v.status).toBe(201);
  return { templateId: t.body.id as string, versionId: v.body.id as string };
}

const sign = (versionIds: string[], extra: Record<string, unknown> = {}) => ({ version_ids: versionIds, accepted: true, signed_name: 'Pat Leader', ...extra });

async function required(resourceIds: string[]) {
  return (await call(requiredApi.onRequestGet, { env, path: `/api/agreements/required?resource_ids=${resourceIds.join(',')}` })).body as { version_id: string; title: string }[];
}

describe('which agreements apply (FR20 §5.3)', () => {
  it('applies agreements assigned to the resource, to anything it is part of, and to every booking', async () => {
    const child = await db.prepare("SELECT id FROM resources WHERE parent_id = 'res_whole' LIMIT 1").first<{ id: string }>();
    const venue = await agreement('Venue conditions', ['res_whole']);
    const kitchen = await agreement('Kitchen hygiene', ['res_kitchen']);
    const all = await agreement('Safeguarding', [], 'Safeguarding policy applies to everyone.', { applies_to_all: true });

    expect((await required([child!.id])).map((r) => r.version_id).sort()).toEqual([venue.versionId, all.versionId].sort());
    expect((await required(['res_whole'])).map((r) => r.version_id).sort()).toEqual([venue.versionId, all.versionId].sort());
    // Assigned to a part, it does not apply to the whole or to other parts.
    expect((await required(['res_field'])).map((r) => r.version_id)).not.toContain(kitchen.versionId);
    expect((await required(['res_whole'])).map((r) => r.version_id)).not.toContain(kitchen.versionId);
    expect((await required(['res_kitchen'])).map((r) => r.version_id)).toContain(kitchen.versionId);
  });

  it('uses the latest version in effect and ignores versions not yet in effect', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    await call(versionsApi.onRequestPost, { env, cookie: superAdmin, params: { id: a.templateId }, body: { body: 'New wording from next month.', effective_from: future() } });
    expect((await required(['res_main'])).map((r) => r.version_id)).toEqual([a.versionId]);

    const v3 = await call(versionsApi.onRequestPost, { env, cookie: superAdmin, params: { id: a.templateId }, body: { body: 'Wording in effect today.', effective_from: new Date().toISOString() } });
    expect(v3.body.version_number).toBe(3);
    expect((await required(['res_main'])).map((r) => r.version_id)).toEqual([v3.body.id]);

    // A form still showing the old version is asked again.
    const stale = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5), agreements: sign([a.versionId]) } });
    expect(stale.status).toBe(400);
    expect(stale.body.details.code).toBe('agreements_required');
    expect(stale.body.details.required[0].version_id).toBe(v3.body.id);
  });

  it('ignores retired agreements', async () => {
    const a = await agreement('Old rules', ['res_main']);
    await call(templateOne.onRequestPut, { env, cookie: superAdmin, method: 'PUT', params: { id: a.templateId }, body: { title: 'Old rules', resource_ids: ['res_main'], is_active: false } });
    expect(await required(['res_main'])).toEqual([]);
  });
});

describe('accepting agreements when booking (FR20 §5.4–5.5)', () => {
  it('refuses a booking until every agreement is accepted and signed, then records the exact version', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    const window = inDays(5);

    const none = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...window } });
    expect(none.status).toBe(400);
    expect(none.body.details.required.map((r: { title: string }) => r.title)).toEqual(['Hire conditions']);
    const unsigned = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...window, agreements: sign([a.versionId], { signed_name: '' }) } });
    expect(unsigned.status).toBe(400);
    const unticked = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...window, agreements: sign([a.versionId], { accepted: false }) } });
    expect(unticked.status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM bookings').first<{ n: number }>()).toEqual({ n: 0 });

    const ok = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...window, agreements: sign([a.versionId]) } });
    expect(ok.status).toBe(201);

    const v = await db.prepare('SELECT content_hash FROM agreement_versions WHERE id = ?').bind(a.versionId).first<{ content_hash: string }>();
    const row = await db.prepare(
      'SELECT a.version_id, a.content_hash, a.accepted_by, s.signed_name FROM agreement_acceptances a JOIN agreement_signatures s ON s.id = a.signature_id WHERE a.booking_id = ?',
    ).bind(ok.body.id).first();
    expect(row).toEqual({ version_id: a.versionId, content_hash: v!.content_hash, accepted_by: 'u1', signed_name: 'Pat Leader' });

    const audit = await db.prepare("SELECT actor_id, actor_type, entity_label FROM audit_events WHERE action = 'agreement.accepted' AND booking_id = ?").bind(ok.body.id).first();
    expect(audit).toEqual({ actor_id: 'u1', actor_type: 'customer', entity_label: 'Hire conditions (version 1)' });
  });

  it('keeps a drawn signature when one is given, and rejects anything that is not a PNG', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const bad = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5), agreements: sign([a.versionId], { signature_image: 'data:text/html;base64,PHNjcmlwdD4=' }) } });
    expect(bad.status).toBe(400);
    const ok = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5), agreements: sign([a.versionId], { signature_image: png }) } });
    expect(ok.status).toBe(201);
    const view = await call(bookingAgreements.onRequestGet, { env, cookie: customer, params: { id: ok.body.id } });
    expect(view.body[0]).toMatchObject({ title: 'Hire conditions', version_number: 1, signed_name: 'Pat Leader', signature_image: png, has_drawn_signature: true });
  });

  it('records acceptances for each resource of a multi-resource booking and each date of a series', async () => {
    const hall = await agreement('Hall rules', ['res_main']);
    const kitchen = await agreement('Kitchen hygiene', ['res_kitchen']);
    const group = await call(bookingsApi.onRequestPost, {
      env, cookie: customer, body: { resource_id: 'res_main', additional_resource_ids: ['res_kitchen'], ...inDays(6), agreements: sign([hall.versionId, kitchen.versionId]) },
    });
    expect(group.status).toBe(201);
    const rows = await db.prepare('SELECT b.resource_id, a.version_id FROM agreement_acceptances a JOIN bookings b ON b.id = a.booking_id ORDER BY b.resource_id').all();
    expect(rows.results).toEqual([{ resource_id: 'res_kitchen', version_id: kitchen.versionId }, { resource_id: 'res_main', version_id: hall.versionId }]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agreement_signatures').first<{ n: number }>())?.n).toBe(1);

    let start = addDays(londonToday(), 40);
    while (new Date(`${start}T12:00:00Z`).getUTCDay() !== 2) start = addDays(start, 1);
    const pattern = { resource_id: 'res_main', frequency: 'weekly', start_date: start, start_time: '19:00', end_time: '21:00', count: 3 };
    expect((await call(seriesApi.onRequestPost, { env, cookie: customer, body: pattern })).status).toBe(400);
    const series = await call(seriesApi.onRequestPost, { env, cookie: customer, body: { ...pattern, agreements: sign([hall.versionId]) } });
    expect(series.status).toBe(201);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM agreement_acceptances a JOIN bookings b ON b.id = a.booking_id WHERE b.series_id = ?').bind(series.body.id).first<{ n: number }>();
    expect(n?.n).toBe(3);
  });

  it('records an administrator accepting on a customer’s behalf', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    const booker = await sessionFor(env, 'booker');
    const res = await call(bookingsApi.onRequestPost, { env, cookie: booker, body: { resource_id: 'res_main', ...inDays(5), on_behalf_of_user_id: 'u1', agreements: sign([a.versionId]) } });
    expect(res.status).toBe(201);
    const sig = await db.prepare('SELECT signed_by, on_behalf_of FROM agreement_signatures').first();
    expect(sig).toEqual({ signed_by: 'booker', on_behalf_of: 'u1' });
  });

  it('never changes or deletes versions, signatures or acceptances', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    const ok = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5), agreements: sign([a.versionId]) } });
    await expect(db.prepare("UPDATE agreement_versions SET body = 'changed'").run()).rejects.toThrow(/cannot be changed/);
    await expect(db.prepare('DELETE FROM agreement_versions').run()).rejects.toThrow(/cannot be deleted/);
    await expect(db.prepare("UPDATE agreement_signatures SET signed_name = 'Someone else'").run()).rejects.toThrow(/cannot be changed/);
    await expect(db.prepare('DELETE FROM agreement_acceptances WHERE booking_id = ?').bind(ok.body.id).run()).rejects.toThrow(/cannot be deleted/);
  });
});

describe('change requests (FR20 §5.8)', () => {
  it('asks for acceptance again only when the change brings in agreements not yet accepted', async () => {
    const hall = await agreement('Hall rules', ['res_main']);
    const kitchen = await agreement('Kitchen hygiene', ['res_kitchen']);
    const first = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5), agreements: sign([hall.versionId]) } });
    const second = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(7), agreements: sign([hall.versionId]) } });

    // Same resource, same agreements: nothing to accept.
    const quoteSame = await call(quoteApi.onRequestPost, { env, cookie: customer, params: { id: first.body.id }, body: { resource_id: 'res_main', ...inDays(5, 13, 15) } });
    expect(quoteSame.body.agreements_required).toEqual([]);
    expect((await call(amendApi.onRequestPost, { env, cookie: customer, params: { id: first.body.id }, body: { resource_id: 'res_main', ...inDays(5, 13, 15) } })).status).toBe(201);

    // Moving to the kitchen brings in its agreement.
    const move = { resource_id: 'res_kitchen', ...inDays(7) };
    const quoteMove = await call(quoteApi.onRequestPost, { env, cookie: customer, params: { id: second.body.id }, body: move });
    expect(quoteMove.body.agreements_required.map((r: { version_id: string }) => r.version_id)).toEqual([kitchen.versionId]);
    const refused = await call(amendApi.onRequestPost, { env, cookie: customer, params: { id: second.body.id }, body: move });
    expect(refused.status).toBe(400);
    expect(refused.body.details.code).toBe('agreements_required');
    const ok = await call(amendApi.onRequestPost, { env, cookie: customer, params: { id: second.body.id }, body: { ...move, agreements: sign([kitchen.versionId]) } });
    expect(ok.status).toBe(201);
    const row = await db.prepare('SELECT amendment_id, version_id FROM agreement_acceptances WHERE booking_id = ? AND amendment_id IS NOT NULL').bind(second.body.id).first();
    expect(row).toEqual({ amendment_id: ok.body.id, version_id: kitchen.versionId });
  });
});

describe('viewing accepted agreements (FR20 §5.6)', () => {
  it('shows Viewers what was accepted and when, but not the signature', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    const ok = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5), agreements: sign([a.versionId]) } });
    const viewer = await sessionFor(env, 'viewer');
    const seen = await call(bookingAgreements.onRequestGet, { env, cookie: viewer, params: { id: ok.body.id } });
    expect(seen.body[0]).toMatchObject({ title: 'Hire conditions', version_number: 1, signed_name: null, signature_image: null });
    await addUser(db, 'u2');
    expect((await call(bookingAgreements.onRequestGet, { env, cookie: await sessionFor(env, 'u2'), params: { id: ok.body.id } })).status).toBe(403);

    const list = await call(acceptancesApi.onRequestGet, { env, cookie: viewer, params: { id: a.templateId } });
    expect(list.body).toHaveLength(1);
    expect(list.body[0].booking_reference).toBeTruthy();
  });
});

describe('managing agreements (FR20 §5.1–5.2, §5.10)', () => {
  it('is for Super Admins only; other administrators can view', async () => {
    const booker = await sessionFor(env, 'booker');
    expect((await call(templatesApi.onRequestPost, { env, cookie: booker, body: { title: 'Rules' } })).status).toBe(403);
    const a = await agreement('Hire conditions', ['res_main']);
    expect((await call(versionsApi.onRequestPost, { env, cookie: booker, params: { id: a.templateId }, body: { body: 'Some new wording here.', effective_from: past() } })).status).toBe(403);
    const list = await call(templatesApi.onRequestGet, { env, cookie: booker });
    expect(list.body[0]).toMatchObject({ title: 'Hire conditions', current_version: 1, resource_ids: ['res_main'] });
    expect((await call(templatesApi.onRequestGet, { env, cookie: customer })).status).toBe(403);
  });

  it('audits template changes, assignments and new versions', async () => {
    const a = await agreement('Hire conditions', ['res_main']);
    await call(templateOne.onRequestPut, { env, cookie: superAdmin, method: 'PUT', params: { id: a.templateId }, body: { title: 'Hire conditions', resource_ids: ['res_main', 'res_small'] } });
    const actions = await db.prepare('SELECT action FROM audit_events WHERE entity_id = ? ORDER BY seq').bind(a.templateId).all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual(['agreement.created', 'agreement.resources_changed', 'agreement.version_published', 'agreement.resources_changed']);
  });

  it('stores an attached PDF privately and serves it only to signed-in users', async () => {
    const t = await call(templatesApi.onRequestPost, { env, cookie: superAdmin, body: { title: 'Hire conditions', resource_ids: ['res_main'] } });
    const upload = async (bytes: string, type: string) => {
      const form = new FormData();
      form.set('body', 'See the attached hire conditions.');
      form.set('effective_from', past());
      form.set('file', new File([bytes], 'conditions.pdf', { type }));
      const request = new Request('http://localhost/api/admin/agreements/x/versions', { method: 'POST', headers: { cookie: superAdmin }, body: form });
      const res = await versionsApi.onRequestPost({ request, env, params: { id: t.body.id } } as unknown as Parameters<typeof versionsApi.onRequestPost>[0]);
      return { status: res.status, body: (await res.json()) as { id: string } };
    };
    expect((await upload('<html>', 'application/pdf')).status).toBe(400);
    expect((await upload('%PDF-1.4 hello', 'text/plain')).status).toBe(400);
    const ok = await upload('%PDF-1.4 hello', 'application/pdf');
    expect(ok.status).toBe(201);

    expect((await call(pdfApi.onRequestGet, { env, params: { id: ok.body.id } })).status).toBe(401);
    const res = await call(pdfApi.onRequestGet, { env, cookie: customer, params: { id: ok.body.id } });
    expect(res.status).toBe(200);
    expect(res.body).toBe('%PDF-1.4 hello');
    expect((await required(['res_main']))[0]).toMatchObject({ has_pdf: true });
  });
});

describe('agreement wording (FR20 §5.1)', () => {
  it('supports headings, lists, bold and links, and drops unsafe links', async () => {
    const { parseAgreementText } = await import('@shared/agreement-text');
    const blocks = parseAgreementText('# Rules\n\nRead the **fire** [plan](https://example.org/fire) and [this](javascript:alert(1)).\n\n- Tidy up\n- Lock the door');
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, children: [{ type: 'text', text: 'Rules' }] });
    const para = blocks[1].type === 'paragraph' ? blocks[1].children : [];
    expect(para.slice(0, 6)).toMatchObject([
      { type: 'text', text: 'Read the ' },
      { type: 'bold', children: [{ type: 'text', text: 'fire' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://example.org/fire' },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'this' },
    ]);
    // The unsafe link is kept only as its words, never as a link.
    expect(para.filter((n) => n.type === 'link')).toHaveLength(1);
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: false, items: [[{ text: 'Tidy up' }], [{ text: 'Lock the door' }]] });
  });
});
