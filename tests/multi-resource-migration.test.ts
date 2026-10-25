import { describe, it, expect } from 'vitest';
import { addUser, createTestEnv } from './helpers/d1';

describe('migration 0024 (one booking for several resources)', () => {
  it('gives existing bookings their resource line, price and change-request resource lists', async () => {
    const { db, dispose, applyRemaining } = await createTestEnv({ stopBefore: '0024' });
    try {
      await addUser(db, 'u1');
      const ts = new Date().toISOString();
      await db.prepare(
        `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model, unit_price_pence,
                               total_amount_pence, base_amount_pence, discount_pence, discount_label, price_breakdown, created_at, updated_at)
         VALUES ('bk1', 'SS-OLD001', 'u1', 'res_main', '2027-01-01T10:00:00.000Z', '2027-01-01T12:00:00.000Z', 'confirmed', 'cat_scouts', 'hourly', 1000,
                 1800, 2000, 200, 'Winter offer', '{"total_pence":1800}', ?, ?)`,
      ).bind(ts, ts).run();
      await db.prepare(
        `INSERT INTO booking_amendments (id, booking_id, requested_by, status, from_resource_id, from_starts_at, from_ends_at, from_total_pence,
                                         to_resource_id, to_starts_at, to_ends_at, to_total_pence, price_breakdown, created_at, updated_at)
         VALUES ('amd1', 'bk1', 'u1', 'rejected', 'res_main', 'a', 'b', 1800, 'res_small', 'c', 'd', 900, '{}', ?, ?)`,
      ).bind(ts, ts).run();

      await applyRemaining();

      expect(await db.prepare('SELECT resource_id, total_amount_pence, base_amount_pence, discount_pence, discount_label FROM booking_resources WHERE booking_id = ?').bind('bk1').all().then((r) => r.results)).toEqual([
        { resource_id: 'res_main', total_amount_pence: 1800, base_amount_pence: 2000, discount_pence: 200, discount_label: 'Winter offer' },
      ]);
      expect(await db.prepare("SELECT from_resource_ids, to_resource_ids FROM booking_amendments WHERE id = 'amd1'").first()).toEqual({
        from_resource_ids: '["res_main"]', to_resource_ids: '["res_small"]',
      });
    } finally {
      await dispose();
    }
  });
});
