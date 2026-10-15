import type { Env } from './http';
import { newId, now } from './http';

/**
 * Bring a resource's mandatory conflicts in line with its type:
 * - it always conflicts with itself;
 * - a combined resource (e.g. Whole Venue) conflicts with every other
 *   resource, and every resource conflicts with every combined resource.
 * Both directions are stored. Existing configurable edges that become
 * mandatory are upgraded; mandatory edges that no longer apply (after a type
 * change) are downgraded to configurable ones rather than deleted.
 */
export async function syncMandatoryConflicts(env: Env, resourceId: string): Promise<void> {
  const ts = now();
  const resource = await env.DB.prepare('SELECT resource_type FROM resources WHERE id = ?')
    .bind(resourceId)
    .first<{ resource_type: string }>();
  if (!resource) return;

  const partners = await env.DB.prepare(
    resource.resource_type === 'combined'
      ? 'SELECT id FROM resources WHERE id <> ?'
      : "SELECT id FROM resources WHERE id <> ? AND resource_type = 'combined'",
  )
    .bind(resourceId)
    .all<{ id: string }>();

  const upsert = (a: string, b: string) =>
    env.DB.prepare(
      `INSERT INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(resource_id, conflicts_with_id) DO UPDATE SET is_mandatory = 1`,
    ).bind(newId('rc'), a, b, ts);

  const statements = [
    // Downgrade edges that are no longer mandatory: neither side is combined.
    env.DB.prepare(
      `UPDATE resource_conflicts SET is_mandatory = 0
       WHERE is_mandatory = 1 AND resource_id <> conflicts_with_id
         AND (resource_id = ? OR conflicts_with_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM resources r
           WHERE r.id IN (resource_conflicts.resource_id, resource_conflicts.conflicts_with_id)
             AND r.resource_type = 'combined'
         )`,
    ).bind(resourceId, resourceId),
    upsert(resourceId, resourceId),
  ];
  for (const p of partners.results) {
    statements.push(upsert(resourceId, p.id), upsert(p.id, resourceId));
  }
  await env.DB.batch(statements);
}
