import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { ancestorIds } from '@shared/hierarchy';

/**
 * Public: the groups resources can be filtered by on the resources page,
 * such as Indoor or Outdoor. A group is any resource with at least one
 * bookable resource beneath it, whether or not the group itself can be
 * booked. In tree order, with each group's depth.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare('SELECT id, name, slug, parent_id, is_active FROM resources ORDER BY name').all<{
    id: string; name: string; slug: string; parent_id: string | null; is_active: number;
  }>();
  const all = rows.results;
  const groupIds = new Set(all.filter((r) => r.is_active).flatMap((r) => ancestorIds(r.id, all)));
  const out: { id: string; name: string; slug: string; parent_id: string | null; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const r of all) {
      if (r.parent_id !== parentId) continue;
      if (groupIds.has(r.id)) out.push({ id: r.id, name: r.name, slug: r.slug, parent_id: r.parent_id, depth });
      visit(r.id, groupIds.has(r.id) ? depth + 1 : depth);
    }
  };
  visit(null, 0);
  return json(out);
};
