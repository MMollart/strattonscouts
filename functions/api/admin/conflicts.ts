import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';
import { conflictUpsertSchema } from '@shared/validation';

// Admin: list the full conflict matrix.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    'SELECT id, resource_id, conflicts_with_id, is_mandatory FROM resource_conflicts',
  ).all();
  return json(rows.results.map((r) => ({ ...r, is_mandatory: !!(r.is_mandatory as number) })));
};

// Admin: add a (non-mandatory) conflict. Conflicts are bidirectional.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'resources.manage');
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = conflictUpsertSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  const { resource_id, conflicts_with_id } = parsed.data;
  if (resource_id === conflicts_with_id) {
    return error('Self-conflicts are mandatory and already exist', 400);
  }

  const ts = now();
  // Insert both directions to keep the matrix bidirectional and explicit.
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at) VALUES (?, ?, ?, 0, ?)',
    ).bind(newId('rc'), resource_id, conflicts_with_id, ts),
    env.DB.prepare(
      'INSERT OR IGNORE INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at) VALUES (?, ?, ?, 0, ?)',
    ).bind(newId('rc'), conflicts_with_id, resource_id, ts),
  ]);

  return json({ ok: true }, 201);
};

// Admin: remove a configurable conflict. Mandatory conflicts cannot be removed.
export const onRequestDelete: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'resources.manage');
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = conflictUpsertSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  const { resource_id, conflicts_with_id } = parsed.data;

  // Refuse to delete mandatory relationships (self-conflicts, Whole Venue rules).
  const mandatory = await env.DB.prepare(
    'SELECT 1 FROM resource_conflicts WHERE is_mandatory = 1 AND ((resource_id = ? AND conflicts_with_id = ?) OR (resource_id = ? AND conflicts_with_id = ?)) LIMIT 1',
  )
    .bind(resource_id, conflicts_with_id, conflicts_with_id, resource_id)
    .first();
  if (mandatory) return error('Mandatory conflicts cannot be removed', 400);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM resource_conflicts WHERE resource_id = ? AND conflicts_with_id = ? AND is_mandatory = 0').bind(resource_id, conflicts_with_id),
    env.DB.prepare('DELETE FROM resource_conflicts WHERE resource_id = ? AND conflicts_with_id = ? AND is_mandatory = 0').bind(conflicts_with_id, resource_id),
  ]);

  return json({ ok: true });
};
