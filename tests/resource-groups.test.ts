import { describe, it, expect } from 'vitest';
import { createTestEnv } from './helpers/d1';
import { call } from './helpers/http';
import * as groupsApi from '../functions/api/resources/groups';

describe('resource groups for the resources page filter', () => {
  it('lists every parent with a bookable resource beneath it, active or not, in tree order', async () => {
    const { env, db, dispose } = await createTestEnv();
    try {
      const ts = new Date().toISOString();
      // An Indoor group that cannot itself be booked, under the Whole Venue, holding the halls.
      await db.prepare(
        "INSERT INTO resources (id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, parent_id, created_at, updated_at) VALUES ('res_indoor', 'Indoor', 'indoor', '', 'individual', 0, 0, 'hourly', 'res_whole', ?, ?)",
      ).bind(ts, ts).run();
      await db.prepare("UPDATE resources SET parent_id = 'res_indoor' WHERE id IN ('res_main', 'res_small')").run();
      // A group with nothing bookable left in it is not offered.
      await db.prepare("UPDATE resources SET is_active = 0 WHERE id = 'res_whole'").run();

      const res = await call(groupsApi.onRequestGet, { env });
      expect(res.body).toEqual([
        { id: 'res_whole', name: 'Whole Venue', slug: 'whole-venue', parent_id: null, depth: 0 },
        { id: 'res_indoor', name: 'Indoor', slug: 'indoor', parent_id: 'res_whole', depth: 1 },
      ]);

      await db.prepare("UPDATE resources SET is_active = 0 WHERE id IN ('res_main', 'res_small')").run();
      expect((await call(groupsApi.onRequestGet, { env })).body.map((g: { id: string }) => g.id)).toEqual(['res_whole']);
    } finally {
      await dispose();
    }
  });
});
