import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';
import { canonicalIso } from '../../_lib/availability-sql';
import { closureSchema } from '@shared/validation';

// Admin: list closures (optionally filtered by resource).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const resourceId = new URL(request.url).searchParams.get('resource_id');
  const rows = resourceId
    ? await env.DB.prepare('SELECT id, resource_id, starts_at, ends_at, reason FROM resource_closures WHERE resource_id = ? ORDER BY starts_at').bind(resourceId).all()
    : await env.DB.prepare('SELECT id, resource_id, starts_at, ends_at, reason FROM resource_closures ORDER BY starts_at').all();
  return json(rows.results);
};

// Admin: create a closure / unavailable period.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = closureSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const id = newId('cls');
  await env.DB.prepare(
    'INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      parsed.data.resource_id,
      canonicalIso(parsed.data.starts_at),
      canonicalIso(parsed.data.ends_at),
      parsed.data.reason ?? null,
      now(),
    )
    .run();
  return json({ id }, 201);
};

// Admin: delete a closure. Body: { id }
export const onRequestDelete: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return error('Invalid JSON body');
  }
  if (!body.id) return error('id is required', 400);
  await env.DB.prepare('DELETE FROM resource_closures WHERE id = ?').bind(body.id).run();
  return json({ ok: true });
};
